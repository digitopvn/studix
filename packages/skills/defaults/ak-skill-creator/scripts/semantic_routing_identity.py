"""Catalog-restructure diagnostics: identity maps, case remapping, owner comparison.

A plain comparison requires one canonical roster. When skills are renamed,
merged, split or removed, an explicit identity map translates the baseline
roster into the candidate roster so both runs are judged against the same task
owner. The map is authored evidence; nothing here infers owners from names.
"""
from collections import Counter
from semantic_routing_contract import fields, fingerprint, text, validate_cases

KINDS = ("rename", "merge", "split", "remove")


def resolver(document, before_roster, after_roster):
    """Validate an identity map and return {baseline id: candidate owners}."""
    fields(document, ("schema_version", "mappings"), ("case_owners",))
    if document["schema_version"] != 1 or not isinstance(document["mappings"], list):
        raise ValueError("invalid identity map")
    before, after = set(before_roster), set(after_roster)
    resolved = {"none": ("none",)}
    for mapping in document["mappings"]:
        fields(mapping, ("from", "to", "kind"), ("note",))
        source, targets, kind = mapping["from"], mapping["to"], mapping["kind"]
        if source not in before or source in resolved:
            raise ValueError("identity map source is unknown or repeated")
        if kind not in KINDS or not isinstance(targets, list) or len(set(targets)) != len(targets):
            raise ValueError("invalid identity map kind or targets")
        if not all(isinstance(t, str) and t in after for t in targets):
            raise ValueError("identity map target is not in the candidate roster")
        expected_count = {"rename": len(targets) == 1 and targets[0] != source, "merge": len(targets) == 1,
                          "split": len(targets) >= 2, "remove": not targets}[kind]
        if not expected_count:
            raise ValueError(f"{kind} mapping has the wrong number of targets")
        if "note" in mapping and not text(mapping["note"], 512):
            raise ValueError("invalid identity map note")
        resolved[source] = tuple(targets) if targets else ("none",)
    for skill in before - set(resolved):
        if skill not in after:
            raise ValueError("baseline skill is missing from the candidate roster and the identity map")
        resolved[skill] = (skill,)
    owners = document.get("case_owners", {})
    if not isinstance(owners, dict) or not all(isinstance(k, str) and (v == "none" or v in after) for k, v in owners.items()):
        raise ValueError("invalid case_owners")
    return resolved


def remap_document(cases, document, before_roster, after_roster):
    """Translate baseline case labels to candidate owners; split owners come from case_owners."""
    resolved = resolver(document, before_roster, after_roster)
    owners = document.get("case_owners", {})
    used = set()
    remapped = []
    for case in cases["cases"]:
        if case["expected"] not in resolved:
            raise ValueError("case label is not in the baseline roster")
        targets = resolved[case["expected"]]
        if case["id"] in owners:
            if owners[case["id"]] not in targets:
                raise ValueError("case owner is not a target of the case's baseline skill")
            owner = owners[case["id"]]
            used.add(case["id"])
        elif len(targets) == 1:
            owner = targets[0]
        else:
            raise ValueError("split skill case needs an explicit case_owners entry")
        remapped.append(dict(case, expected=owner))
    if set(owners) - used:
        raise ValueError("case_owners names a case that is not in the case set")
    return {"schema_version": cases["schema_version"], "holdout_id": cases["holdout_id"], "cases": remapped}


def remap_cases(cases, document, before_catalog, after_catalog):
    """Validate both catalogs and return the candidate case set for a restructured roster."""
    validate_cases(cases, before_catalog)
    before_roster = sorted(s["id"] for s in before_catalog["skills"])
    after_roster = sorted(s["id"] for s in after_catalog["skills"])
    result = remap_document(cases, document, before_roster, after_roster)
    validate_cases(result, after_catalog)
    return result


def _rows(records, report):
    rows = {}
    for row in records:
        if not isinstance(row, dict) or row.get("catalog_hash") != report.get("catalog_hash"):
            raise ValueError("record does not belong to its report")
        if row.get("case_id") in rows:
            raise ValueError("duplicate record")
        rows[row.get("case_id")] = row
    return rows


def compare_restructure(before, after, before_records, after_records, cases, document):
    """Compare two diagnostic runs whose rosters differ under an explicit identity map."""
    keys = ("protocol", "holdout_id", "split", "runtime", "scope", "batch_schedule", "provider")
    confounds = [k for k in keys if k not in before or k not in after or before[k] is None or before[k] != after[k]]
    if before.get("status") != "completed" or after.get("status") != "completed":
        confounds.append("incomplete_coverage")
    result = {"evidence_kind": "diagnostic_model_choice", "status": "confounded", "confounds": confounds,
              "identity_map_hash": fingerprint(document), "improvement": None}
    if confounds:
        return result
    resolved = resolver(document, before["roster"], after["roster"])
    if fingerprint(cases) != before.get("cases_hash"):
        confounds.append("baseline_cases_mismatch")
    remapped = remap_document(cases, document, before["roster"], after["roster"])
    if fingerprint(remapped) != after.get("cases_hash"):
        confounds.append("candidate_cases_not_derived_from_identity_map")
    if confounds:
        return result
    selected = [c for c in cases["cases"] if c["split"] == before["split"]]
    owner_of = {c["id"]: c["expected"] for c in remapped["cases"]}
    rows_before, rows_after = _rows(before_records, before), _rows(after_records, after)
    if set(rows_before) != {c["id"] for c in selected} or set(rows_after) != set(rows_before):
        confounds.append("records_do_not_cover_selected_cases")
        return result
    totals = Counter()
    by_class = {}
    per_owner = {}
    transitions = {"fixed": [], "regressed": []}
    for case in sorted(selected, key=lambda c: c["id"]):
        owner = owner_of[case["id"]]
        b, a = rows_before[case["id"]], rows_after[case["id"]]
        if b["expected"] != case["expected"] or a["expected"] != owner:
            confounds.append("record_labels_differ_from_cases")
            return result
        # A baseline choice counts for any owner it maps to; a split miss is
        # attributed to the first candidate owner for per-owner counts.
        mapped = resolved[b["predicted"]]
        before_choice = owner if owner in mapped else mapped[0]
        after_choice = a["predicted"]
        # A baseline pick of a skill the map removes is still an activation on a
        # prompt that never had an owner, so those cases judge the raw choice.
        no_owner = case["expected"] == "none"
        stats = by_class.setdefault(case["class"], Counter())
        raw = {"before": b["predicted"], "after": after_choice}
        correct = {}
        for label, choice in (("before", before_choice), ("after", after_choice)):
            correct[label] = raw[label] == "none" if no_owner else choice == owner
            totals[label] += correct[label]
            stats[label] += correct[label]
            if case["class"] == "no-skill" and raw[label] != "none":
                totals[f"{label}_false_activations"] += 1
            wrong = choice if choice != owner else raw[label]
            for skill, outcome in ((owner, "TP" if correct[label] else "FN"), (wrong, None if correct[label] else "FP")):
                if outcome:
                    per_owner.setdefault(skill, {"before": Counter(), "after": Counter()})[label][outcome] += 1
        stats["total"] += 1
        if not correct["before"] and correct["after"]:
            transitions["fixed"].append(case["id"])
        if correct["before"] and not correct["after"]:
            transitions["regressed"].append(case["id"])
    count = len(selected)
    result.update(
        status="matched_restructure",
        owner_accuracy={"before": totals["before"] / count, "after": totals["after"] / count, "cases": count},
        false_activations_on_no_skill={"before": totals["before_false_activations"], "after": totals["after_false_activations"]},
        by_class={k: dict(v) for k, v in sorted(by_class.items())},
        per_owner={k: {side: dict(v[side]) for side in v} for k, v in sorted(per_owner.items())},
        transitions=transitions,
        interpretation="Owner-level diagnostic deltas under an authored identity map; runtime activation remains separate evidence.")
    return result
