import { systemClock } from "@studix/shared";
import { createInMemoryExternalSkillRepository, testTenant } from "../src/testing/index.ts";
import { runExternalSkillRepositoryContract } from "./external-skill-repository-contract.ts";

const repo = createInMemoryExternalSkillRepository(systemClock);

runExternalSkillRepositoryContract("in-memory", {
  repo: () => repo,
  tenant: async (sameOrganizationAs) => testTenant({ organizationId: sameOrganizationAs?.organizationId }),
});
