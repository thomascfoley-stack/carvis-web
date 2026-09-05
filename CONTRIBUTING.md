# Contributing to CARVIS

Thanks for taking a look. Bug reports, feature ideas, and pull requests are all welcome.

## Getting set up

```bash
git clone https://github.com/thomasfoley9/carvis-web.git
cd carvis-web
npm install
cp .env.example .env.local   # fill in your own keys, nothing here is shared
npm run dev
```

Keys are bring-your-own. You'll need a Composio API key for integrations and sign-in, plus whichever model and voice providers you want to use. See the README for the full list.

## Before you open a PR

- Run `npm run typecheck` and `npm run build`.
- Run the test suite if your change touches auth, streaming, MCP, or key handling:

  ```bash
  CARVIS_ALLOW_MEMORY_CREDENTIALS=1 npx tsx test/run.mjs --rounds 2 --loop 80
  ```

- Never commit real keys, endpoints, or `.env` files. `.env.example` is the only env file that belongs in the repo.
- Keep PRs focused. One fix or feature per PR makes review faster.

## Reporting bugs

Open an issue with what you expected, what happened, your browser, and which model/voice provider you were using. Redact any keys or endpoint URLs before pasting logs.

## Security

If you find something that leaks a user's keys or crosses tenant boundaries, please don't open a public issue. Open a private security advisory on GitHub instead.

## License

By contributing, you agree that your contributions are licensed under the MIT License in this repository.
