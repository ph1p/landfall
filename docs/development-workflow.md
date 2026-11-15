# Local Development Workflow

This guide describes how to set up and run the landfall development environment.

## Prerequisites

- **Node.js**: 22.18+ or 24.11+
- **pnpm**: Package manager used for all dependencies and scripts.
- **Docker**: Required only if you plan to run end-to-end (e2e) tests.

## Getting Started

1. **Clone the repository**:
   ```sh
   git clone <repository-url>
   cd landfall
   ```

2. **Install dependencies**:
   ```sh
   pnpm install
   ```

## Development Commands

The project uses `pnpm dev` to run commands from source (using `tsx`) without needing to build the project first.

### Running the CLI
Instead of installing the package globally, use `pnpm dev <command>` to run any command from source:
```sh
pnpm dev deploy --help
```

### Testing
- **Unit Tests**: Run all unit tests (including remote script mocks):
  ```sh
  pnpm test
  ```
- **Type Checking**: Ensure type safety for the CLI and Web UI:
  ```sh
  pnpm typecheck
  ```
- **Linting & Formatting**: Check code style:
  ```sh
  pnpm lint
  pnpm fmt:check
  ```

### Building
To build the project for production (generating `dist/cli.mjs` and `dist/ui`):
```sh
pnpm build
```

### End-to-End (e2e) Tests
E2E tests run against a throwaway container with `sshd` and `dockerd`. This requires Docker.
```sh
pnpm e2e
```
To run only specific sections (e.g., just the UI):
```sh
E2E_ONLY="volumes ui" pnpm e2e
```

## Development Workflow Notes

- **Remote Scripts**: Most logic that interacts with servers is written as bash scripts. These are tested in `test/unit/` by mocking the SSH layer and verifying the generated shell commands.
- **The Web UI**: The UI is a Vite-based React application. You can run it in development mode with `pnpm dev:ui` (which rebuilds the UI on change).
- **Layer Rules**: 
  - `src/core` should not import from `src/cli` or `src/ui`.
  - `src/ui` should not import from `src/cli`.
  - The UI communicates with the CLI via subprocesses.

## Troubleshooting

If you encounter issues with environment variables or Node versions, ensure you are using the recommended Node.js versions (22.18+ or 24.11+).
