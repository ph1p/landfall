# Agent Handoff Checklist

Use this checklist when delegating tasks to a coding agent working on Landfall.

## 1. Definition
- [ ] **Goal & Acceptance Criteria:** Clearly define the objective and what constitutes a successful completion.
- [ ] **Scope of Change:** Specify the exact files allowed to be modified.

## 2. Execution
- [ ] **Relevant Checks:** Run all required tests and linting commands as specified in `AGENTS.md`.
- [ ] **Scratch Space:** Ensure all temporary helper files or scratchpad data are written to `/tmp` and not committed.

## 3. Review & Handoff
- [ ] **Diff Inspection:** Thoroughly review the generated diff for correctness, adherence to project conventions, and unintended side effects.
- [ ] **CI/Build Validation:** Verify that the changes pass all CI checks (linting, typechecking, tests) before proposing a merge or release.
- [ ] **No Secret Leaks:** Confirm that no secrets, credentials, or sensitive environment variables are present in the code or logs.
