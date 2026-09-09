# @xeplr/base-apis

The service layer for a xeplr app: `createApp` wires an Express service, and
`genericRoute` gives any model a full CRUD API. Composes with `@xeplr/db` and
`@xeplr/auth`.

## Setup

1. Install `@xeplr/base-apis` (add `@xeplr/db`, `@xeplr/auth`, `dotenv`).
2. Create a file env.required.js
3. For anything
3. Each API is by default guarded through Auth System. But you will need following variables in your env file for AUTH: AUTH_DB_NAME, AUTH_DB_CONNECTION_INFO_ENCRYPTED, XEPLR_AUTH_MIGRATIONS, AUTH_PORT. 
4. The XEPLR_AUTH_MIGRATIONS is y

Example:

```bash
var { resolveConfig, getConnection, bindModels } = require('@xeplr/db');

async function setup() {
  var dbName = process.env.DB_API || 'xeplr_bi';
  await resolveConfig('api', process.env.BI_CONNECTION);   // one shared secret
  var connection = getConnection(dbName, { connectionName: 'api' });
  bindModels(connection);
  return connection;
}

module.exports = setup();
```

4. Define models (extend `BaseModel`).
5. Expose CRUD routes with `genericRoute`, one per resource.
6. Create the service with `createApp` — mount routes, add auth middleware.
7. Write migrations (schema + data) and run them.
8. Start the app.
