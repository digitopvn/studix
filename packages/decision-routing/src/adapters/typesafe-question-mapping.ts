import { decisionError } from "../decision-errors.ts";
import type { DecisionRequest, JsonSchema } from "../decision-types.ts";

/**
 * TypeSafe System One models (Jev) answer typed questions about a `state`; they do not generate free-form
 * JSON. A decision is therefore mapped onto questions and the typed answers are folded back into the
 * output object, which is then validated against the request schema like any other provider output.
 *
 * Wire shapes follow https://docs.typesafe.ai/api/system-one (POST /v1/systemone).
 */

export type TypeSafeQuestion =
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export interface TypeSafeAnswer {
  type: string;
  noul?: number;
  choice?: string;
  score?: number;
  confidence?: number | null;
  probabilities?: Record<string, number>;
}

export interface TypeSafeQuestionPlan {
  state: unknown;
  questions: Record<string, TypeSafeQuestion>;
  /** Fold answers into the decision output (validated by the caller's schema afterwards). */
  toOutput(answers: Record<string, TypeSafeAnswer>): unknown;
}

/** Custom per-kind mapping for decisions that do not fit the default flat-schema mapping. */
export type TypeSafeQuestionMapper = (
  request: DecisionRequest<unknown>,
  jsonSchema: JsonSchema,
) => TypeSafeQuestionPlan;

/** TypeSafe accepts 1-255 options per Choice question. */
const MAX_CHOICE_OPTIONS = 255;

type FieldPlan = { kind: "choice"; options: string[] } | { kind: "noul" } | { kind: "const"; value: unknown };

function unsupported(message: string) {
  return decisionError("PROVIDER_ERROR", "unsupported", `TypeSafe cannot answer this decision: ${message}`, {
    retryable: false,
    suggestedAction: "Register a TypeSafe question mapper for this decision kind or route it elsewhere.",
  });
}

function planField(name: string, property: unknown): FieldPlan {
  const prop = (property ?? {}) as { enum?: unknown; type?: unknown; const?: unknown };
  if (prop.const !== undefined) return { kind: "const", value: prop.const };
  if (Array.isArray(prop.enum)) {
    const options = prop.enum;
    if (
      options.length === 0 ||
      options.length > MAX_CHOICE_OPTIONS ||
      !options.every((o) => typeof o === "string")
    ) {
      throw unsupported(`field "${name}" must be a string enum with 1-${MAX_CHOICE_OPTIONS} options`);
    }
    return { kind: "choice", options: options as string[] };
  }
  if (prop.type === "boolean") return { kind: "noul" };
  throw unsupported(`field "${name}" is not a string enum, boolean or constant`);
}

/**
 * Default mapping: a flat object schema whose properties are string enums (-> Choice), booleans (-> Noul,
 * true when p(yes) >= 0.5) or constants. Every property becomes one question asked in a single request.
 */
export function mapFlatSchemaToQuestions(
  request: DecisionRequest<unknown>,
  jsonSchema: JsonSchema,
): TypeSafeQuestionPlan {
  const properties = jsonSchema.properties as Record<string, { description?: unknown }> | undefined;
  if (jsonSchema.type !== "object" || !properties || Object.keys(properties).length === 0) {
    throw unsupported("output schema must be a flat object with at least one property");
  }
  const task = request.instructions ?? `Make the "${request.kind}" decision about the state.`;
  const fields = Object.entries(properties).map(([name, property]) => ({
    name,
    plan: planField(name, property),
    description: typeof property?.description === "string" ? property.description : undefined,
  }));
  const questions: Record<string, TypeSafeQuestion> = {};
  for (const { name, plan, description } of fields) {
    const instructions = `${task}\nAnswer for "${name}"${description ? `: ${description}` : "."}`;
    if (plan.kind === "choice") {
      questions[name] = {
        type: "choice",
        instructions,
        criteria: Object.fromEntries(plan.options.map((option) => [option, option])),
      };
    } else if (plan.kind === "noul") {
      questions[name] = { type: "noul", instructions };
    }
  }
  if (Object.keys(questions).length === 0) throw unsupported("output schema has no question to ask");
  const state =
    request.input !== null && typeof request.input === "object" ? request.input : { input: request.input };
  return {
    state,
    questions,
    toOutput: (answers) => {
      const output: Record<string, unknown> = {};
      for (const { name, plan } of fields) {
        const answer = answers[name];
        if (plan.kind === "const") output[name] = plan.value;
        else if (plan.kind === "choice") output[name] = answer?.choice;
        else if (typeof answer?.noul === "number") output[name] = answer.noul >= 0.5;
      }
      return output;
    },
  };
}
