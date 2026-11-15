# Agent Handoff Checklist

Use this checklist when delegating tasks to a coding agent. This ensures clear communication, safety, and quality control within the Landfall project.

## 1. Task Definition
- [ ] **Agree on Goal:** Clearly define the objective and expected outcome.
- [ ] **Define Acceptance Criteria:** Specify exactly what constitutes a successful task (e.g., "The command `lf --help` shows the new group").
- [ ] **Scope Constraints:** Explicitly list the allowed files for modification.

## 2. Execution
- [ ] **File Bounds:** Ensure the agent only modifies files within the agreed scope.
- [ ] **Use `/tmp` for Helpers:** All temporary scratch files or helper scripts created during the task must be placed in `/tmp`.
- [ ] **Run Relevant Checks:** Execute all necessary tests and linters as specified in `AGENTS.md` (e.g., `pnpm test`, `pnpm lint`).

## 3. Review & Handoff
- [ ] **Diff Inspection:** Manually review the code changes (the diff) to ensure they align with the goal and follow project conventions.
- [ ] **CI/Testing Verification:** Verify that all automated tests pass and linting is clean.
- [ ] **Final Review:** Before merging or releasing, perform a final check of the changes against the initial acceptance criteria.
