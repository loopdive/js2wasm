# Contributing to js2wasm

`js2wasm` is developed as the core compiler product of **Loopdive GmbH**. This guide covers the technical workflow and the contributor licensing terms required for accepted contributions.

## Development Setup

```bash
git clone https://github.com/loopdive/js2wasm.git
cd js2wasm
pnpm install
```

## Minimum Local Checks

Run these before opening a pull request:

```bash
pnpm typecheck
pnpm lint
npm test
```

For playground work:

```bash
pnpm dev
```

## Test262

Test262 is used as the primary public conformance tracking loop. In this repository it is a measurement and regression tool, not a simple pass/fail gate.

Preferred local command:

```bash
pnpm run test:262
```

PRs may also be validated through CI workflows that compare the branch against the current `main` baseline.

## Contribution Expectations

- Keep changes focused.
- Add regression tests for bug fixes where practical.
- Do not mix unrelated cleanup into a compiler change.
- Preserve the current compiler architecture and repo conventions unless the change explicitly aims to refactor them.

## Contributor License Agreement (CLA)

Contributions to this repository require agreement to the Loopdive contributor terms.

By contributing code, documentation, tests, or other material to this repository, you agree that:

- you have the right to submit the contribution
- you grant **Loopdive GmbH** an irrevocable, worldwide, perpetual, sublicensable license to use, reproduce, modify, distribute, relicense, and otherwise exploit your contribution under any license terms
- you agree that Loopdive GmbH may use your contribution in both open-source and commercial licensing contexts

If you do not agree to these terms, do not submit a contribution.

This CLA requirement exists so the project can maintain an Apache 2.0 with LLVM Exceptions community distribution while also supporting commercial and proprietary licensing arrangements for infrastructure partners.

## Pull Requests

When opening a PR:

- explain the problem being solved
- describe any conformance or behavior impact
- include the relevant tests or rationale if tests are not added

PRs may be subject to an automated CLA check workflow placeholder until a dedicated signature flow is wired in.

## License

The repository source is licensed under **Apache-2.0 WITH LLVM-exception**. See [LICENSE](./LICENSE).

Contributions are accepted only under the CLA terms above.
