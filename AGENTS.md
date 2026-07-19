# Repository Guidelines

## Project Structure & Module Organization

This repository contains the REST Client VS Code extension. `src/extension.ts` is the activation entry point. Feature orchestration lives in `src/controllers/`, editor integrations in `src/providers/`, response UI in `src/views/`, types in `src/models/`, and parsing, authentication, and HTTP logic in `src/utils/`. Static resources are kept in `images/`, `styles/`, `snippets/`, and `syntaxes/`. Build output under `dist/` must not be edited directly. Extension metadata and contributed commands belong in `package.json`.

## Build, Test, and Development Commands

- `npm ci`: install the exact dependency versions from `package-lock.json` (Node 18 matches CI).
- `npm run webpack`: create a development bundle in `dist/`.
- `npm run watch`: rebuild the extension as source files change.
- `npm run vscode:prepublish`: produce the optimized production bundle used for packaging.
- `npm run tslint`: check all TypeScript against the repository's TSLint rules.

Press `F5` in VS Code and select **Launch Extension** to open an Extension Development Host; the launch task builds the project first.

## Coding Style & Naming Conventions

Use TypeScript with four-space indentation, semicolons, strict null checks, and braces for control flow. Keep imports ordered and prefer `const` over `let`; do not use `var`. Name classes, interfaces, and enums in `PascalCase`, and variables, functions, and files in `camelCase` (for example, `requestController.ts`). Place reusable constants in `src/common/constants.ts`. Run `npm run tslint` before submitting changes.

## Testing Guidelines

The repository has no automated test suite or coverage threshold. Validate changes with linting and development and production bundles. Exercise behavior manually in the Extension Development Host using representative `.http` or `.rest` requests. For parser, authentication, or response-view changes, document scenarios and expected results in the pull request. Do not add generated files or credentials to fixtures.

## Commit & Pull Request Guidelines

Follow the existing concise, imperative history: `Add support for ...`, `Fix ...`, or scoped Conventional Commit forms such as `fix: preserve ...`. Keep each commit focused and reference issues when applicable (`Fix #1162`). Pull requests should explain the user-visible change, implementation approach, and verification performed; link related issues and include screenshots or recordings for webview/UI changes. Confirm lint and production build success before requesting review.

## Security & Configuration Tips

Never commit tokens, cookies, client secrets, or private endpoints from REST Client environment files. Use local VS Code settings or ignored files for sensitive values, and redact request/response examples in issues and pull requests.
