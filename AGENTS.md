# AGENTS.md

## Source of truth

- Read `docs/PRODUCT_SPEC.md` completely before planning or changing product behavior.
- `docs/PRODUCT_SPEC.md` is the authoritative product specification.
- Do not change an approved product rule without explicitly explaining the conflict and obtaining user approval.
- Do not implement features listed under “完全に採用しないもの”.
- Apple/Google gallery restoration is a future feature and must not be included in the MVP.

## Working style

- Work on one implementation phase at a time.
- Before editing, state the scope, assumptions, and completion criteria.
- Do not silently expand the requested scope.
- When product requirements conflict or cannot be implemented reliably, stop and explain the conflict.
- Prefer the simplest production-ready implementation that satisfies the specification.
- Update relevant documentation when an architectural decision changes.

## Architecture

- Use a pnpm workspace monorepo.
- Use TypeScript strict mode.
- Keep the puzzle engine independent from React Native and Firebase.
- The server is authoritative for dates, piece generation, FIT eligibility, puzzle merging, deletion, and moderation state.
- Clients must not directly modify canonical puzzle state.
- Keep client-visible puzzle data separate from private safety identities and moderation data.
- Never use the persistent safety ID for recommendations, profiles, social discovery, or cross-day product analytics.
- Never expose secrets, safety IDs, deletion keys, private reports, or moderation data to clients.

## Safety

- Safety, reporting, blocking, deletion, and moderation are MVP requirements, not optional polish.
- Do not open an external beta before the required safety functions and moderation console work.
- Do not use real user photos as development or test fixtures.
- Never commit credentials, Firebase service accounts, signing keys, `.env` files, or production configuration.
- Keep development, staging, and production Firebase projects separate.

## Verification

For every change:

- Add or update tests appropriate to the change.
- Run formatting, linting, type checking, and relevant tests.
- Review the final diff for unintended product changes.
- Report what was verified and what still requires physical-device or manual testing.

After the repository scripts are established, use these root commands:

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm test:emulators`

## Native proximity

- BLE/UWB behavior must be tested on physical iPhone and Android devices.
- Simulated proximity tests cannot be treated as proof of physical distance accuracy.
- Do not describe the BLE fallback as guaranteeing an exact 10 cm distance.

## AI model selection and handoff

- Use `docs/AI_IMPLEMENTATION_GUIDE.md` for per-task Claude Code and Codex model recommendations; keep product rules and verification requirements unchanged.
- At the start of each implementation unit, state the recommended model and explicit reasoning setting (including Claude Code Effort; do not write only "default"). End each implementation report with the next concrete unit, recommended Claude Code and Codex models and effort levels, and a brief reason; report unfinished work as unfinished.
- Treat model recommendations as guidance, not authorization to switch models, delegate to other agents, or incur new charges. Do not stop work solely because the current model differs from the recommendation.
- Give an estimated duration range including verification before work; report the current stage, remaining range, and confidence in Japanese every 30–60 seconds or at stage changes. Explain extensions with a reason and a new range; explicitly write 「見積もり困難」 when a part cannot be estimated. Do not pause work or wait for user confirmation just to report progress.
