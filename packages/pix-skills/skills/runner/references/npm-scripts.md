# package.json (npm scripts)

- No native arg dispatch or dep graph
- Validate: `npm run`
- **Standalone**: direct command string
- **Consolidated via colon namespacing**: `"docker:build"`, `"docker:up"`, `"docker:down"` as separate scripts, parent `"docker"` echoes usage
- **Complex parameterized**: individual `"test:unit"`, `"format:fix"`, `"format:check"` scripts, plus standalone `"lint"`

  ```json
  {
    "scripts": {
      "dev": "next dev",
      "install:deps": "npm ci",
      "docker:build": "docker compose -f docker-compose.dev.yml build",
      "docker:up": "docker compose -f docker-compose.dev.yml up",
      "docker:down": "docker compose -f docker-compose.dev.yml down",
      "test:unit": "jest",
      "test:tidy": "rm -rf node_modules dist .next",
      "format:fix": "prettier --write . && eslint --fix .",
      "format:check": "prettier --check . && eslint .",
      "lint:check": "eslint .",
      "lint:fix": "eslint --fix ."
    }
  }
  ```

  Note: `npm run` has no arg validation or choices — colon namespacing is the closest equivalent.
