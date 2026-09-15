# @xeplr/base-apis

**The service layer for a xeplr app.** `createApp` builds an Express service that is **authenticated by default**, `genericRoute` gives a model hierarchy a full CRUD API, and the rest — env checks, uploads, server-sent events, clustering — is what every service otherwise hand-rolls.

```js
var { createApp, genericRoute } = require('@xeplr/base-apis')

createApp(process.env.PORT, 'myapp', {
  requiredEnv: require('./env.required'),
  routes: { '/api/departments': genericRoute({ key: 'department', model: Department }) }
})
```

## How the pieces fit

| what | where |
|---|---|
| An Express service: logging, CORS, body parsing, auth gate, routes, 404, errors | `createApp(port, appName, options)` |
| Who the caller is | the **auth gate** — asks `@xeplr/auth` at `AUTH_URL`; sets `req.user` and `req.access` |
| List / get / save / delete for a model and its children | `genericRoute(hierarchy)` |
| Refusing to start without the settings a service needs | `checkEnv` / `requiredEnv` / `xeplr-check-env` |
| Server → browser push | `sse` |
| Several processes | `runCluster`, `broadcast` |
| A server without Express | `createHttpServer.init(port, name, handler)` |

Models, tenancy and connections come from [`@xeplr/db`](https://www.npmjs.com/package/@xeplr/db).

## Install

```sh
npm i @xeplr/base-apis express
```

Peers: `express` (4 or 5), `multer` (optional — only for uploads). Depends on `@xeplr/logs` and `@xeplr/utils`.

## Quick start

```js
// env.required.js
module.exports = ['XEPLR_DB_CONNECTION', 'ENCRYPTION_KEY', 'DB_API'].concat(require('@xeplr/base-apis').gateRequiredEnv)
```

```js
var { createApp, genericRoute } = require('@xeplr/base-apis')
var { getConnection, registerMTs, mtMiddleware, BaseModel } = require('@xeplr/db')

registerMTs({ l1: { name: 'companyId', header: 'x-company-id' } })
await getConnection(process.env.DB_API, process.env.XEPLR_DB_CONNECTION)

class Department extends BaseModel { static get tableName() { return 'departments' } }

createApp(3000, 'myapp', {
  requiredEnv: require('./env.required'),
  auth: { publicPaths: ['/public/'] },        // omitted = every route gated
  middleware: [mtMiddleware()],               // runs after the gate, so req.user is set
  routes: { '/api/departments': genericRoute({ key: 'department', model: Department }) }
})
```

## Exports

| export | |
|---|---|
| `createApp(port, appName, options)` | Express service → `{ app, server }` |
| `genericRoute(hierarchy, { auth })` | CRUD router |
| `genericController` | `{ list, getById, save, deleteByIds }` — the handlers behind `genericRoute` |
| `remoteAuth(config)` | the default gate, as middleware |
| `gateRequiredEnv` | `['AUTH_URL']` |
| `checkEnv(names, options)` | missing-variable check |
| `uploadRoute(options)` | a standalone "receive a file, return its path" router |
| `sse` | `{ handler, createHandler, publish, defaultAuthorizeTopics }` |
| `runCluster(options)`, `broadcast(msg)`, `isPrimary()`, `isWorker()` | Node cluster helpers |
| `createHttpServer` | `{ init(port, appName, handler) }` — a plain `http.Server` |

## createApp

`createApp(port, appName, options)` listens on `port` (a number or a named pipe) and returns `{ app, server }`. `EADDRINUSE` / `EACCES` print a message and exit.

| option | |
|---|---|
| `requiredEnv` | variable names; any missing → message and `process.exit(1)` before anything starts |
| `auth` | the gate — see below. **On when omitted** |
| `middleware` | array, mounted after the gate |
| `routes` | `{ '/path': router }` |
| `log` | `@xeplr/logs` settings (`logDir` `'./logs'`, `fatalThreshold`, `emailThreshold`, `emailTo`, `emailService`), or `false` |
| `corsOptions` | passed to `cors` (default: allow all) |
| `staticDir` | `express.static` directory |
| `views` | `{ engine: 'pug', dir }` — also switches 404 and errors to rendered pages |
| `upload` | file upload — see below |
| `sse` | `true` for `GET /events`, or `{ path }` |
| `errorHandler` | replaces the default `{ error: message }` JSON handler |

### Order of the middleware

1. request logger (`@xeplr/logs` — sets `req.log`), unless `log: false`
2. view engine, `cors`, `express.json`, `express.urlencoded`, `cookie-parser`
3. `staticDir`
4. uploaded files served at `upload.serveRoute` — **before the gate, so public**
5. **the auth gate**
6. `options.middleware`
7. `POST upload.route`
8. SSE endpoint
9. `options.routes`
10. 404, then the error handler

### The auth gate

| `auth` | result |
|---|---|
| omitted | gated through `remoteAuth` with `AUTH_URL`. **No `AUTH_URL` → `createApp` throws** |
| `{ url, publicPaths, cacheSeconds, endpoint, timeoutMs }` | gated, configured here |
| `{ middleware: fn }` | your gate instead — how `@xeplr/auth`'s own server gates itself (it cannot ask itself over HTTP) |
| `false` | public, on purpose and visible in the diff |

Why on by default: a service that forgot to configure auth used to boot clean, pass every health check, and serve every route to anybody — nothing distinguished it from a working one.

`remoteAuth` sends the caller's `Authorization: Bearer …` to `url + endpoint` (`/auth/api/me`) and puts the answer's `user` and `access` on `req.user` / `req.access`.

| situation | response |
|---|---|
| path starts with a `publicPaths` entry | skipped |
| no `Bearer` token | 401 `No token provided` |
| auth answers 401 / 403 | same status, `Invalid or expired token` |
| auth unreachable, times out (`timeoutMs`, 5000), answers anything else, or answers non-JSON | **503 `Authentication service unavailable` — never let through** |

- **Validated over HTTP, not in-process** — so a service needs no `@xeplr/auth` dependency (it would be a cycle), no JWT secret and no Redis. The cost is a hop per request.
- **`cacheSeconds` (default 5)** caches a validated token per process; a revoked token keeps working that long here. `0` checks every request.
- **`X-New-Token` is forwarded** (with `Access-Control-Expose-Headers`) when the auth service slides a token, and that answer is **not cached** — otherwise the next requests would be answered from memory without telling the client to switch, and it would be logged out when the window closed.

### Uploads

```js
createApp(port, 'myapp', { upload: { destination: './uploads', allowedTypes: ['image/*'], maxSize: 2e6 } })
```

| option | default |
|---|---|
| `route` | `/internal/upload` — `POST`, multipart, behind the gate |
| `fieldName` | `file` |
| `maxFiles` | `10` |
| `destination` | `UPLOAD_DIR`, else `./uploads` |
| `allowedTypes` | `['*']` |
| `maxSize` | `5242880` (5 MB) |
| `serveRoute` | `/uploads` — static, **before the gate** |
| `auth` | a function passed to `@xeplr/utils`' `FileUploader` |

Returns `{ filename, originalName, size, mimetype }`, or an array of them for several files; 400 when none arrived. Files are stored under a generated id plus the original extension.

`uploadRoute({ destination, maxSize, allowedTypes, fieldName, auth })` is the same as a router of its own: `POST /` (single file) → `{ filePath, fileName, originalName, size, mimetype }`.

## genericRoute

```js
genericRoute({
  key: 'department',
  model: Department,
  children: [
    { key: 'employees', model: Employee, foreignKey: 'departmentId',
      children: [{ key: 'monthlySalaries', model: MonthlySalary, foreignKey: 'employeeId' }] }
  ]
}, { auth: { list: gate, getById: gate, save: [gate, adminOnly], delete: [gate, adminOnly] } })
```

`children[].key` is the Objection relation name; it becomes the eager graph (`employees.monthlySalaries`). `auth` is a middleware, an array, or per operation; omitted means no extra middleware (the `createApp` gate still applies).

| route | does |
|---|---|
| `GET /` | list with children; `?page=1&limit=50` → `pagination: { page, limit, total, totalPages }`; `?limit=0` returns everything |
| `GET /:id` | one record with children; 404 if none |
| `POST /save` | a changeset array, **in one transaction** → `updatedIds` |
| `POST /delete` | `{ ids }` → `isActive = false` |

Queries go through `Model.query()`, so a `BaseModel` gets its active, tenant and application filters.

### The changeset

```json
[
  { "id": "a1b2", "name": "Engineering", "employees": [
      { "name": "New Hire" },
      { "id": "d4e5", "role": "Senior" },
      { "id": "x1y2", "deleted": true } ] },
  { "name": "New Department" }
]
```

| entry | action |
|---|---|
| no `id` | insert with a generated id |
| `id` that exists | patch the fields given |
| `id` that does not exist | insert with that id |
| `deleted: true` | `isActive = false` |
| a key matching a child `key` | processed recursively; the child's `foreignKey` is set to the parent id |

Every query carries `.context({ user: req.user, afterCommit: [] })`. A model hook that must write to **another connection** pushes a function onto `afterCommit` instead of writing inline: the callbacks run only after the transaction commits, so a later failure in the same changeset cannot leave an orphan behind. A failing callback is logged, not returned.

### Responses and errors

Responses use `@xeplr/utils`' shape: `{ code, message, error, dataArray, updatedIds, sessionId }` (+ `pagination`). Database errors are mapped by `err.name` (so two copies of objection still match):

| error | status |
|---|---|
| `ValidationError` | 422 |
| `UniqueViolationError`, `ForeignKeyViolationError` | 409 |
| `NotNullViolationError` (`<column> is required`), `CheckViolationError`, `DataError` | 400 |
| `NotFoundError` | 404 |
| anything else | 500 |

## checkEnv

```js
checkEnv(['XEPLR_DB_CONNECTION', 'AUTH_URL'], { appName: 'myapp' })
```

Options: `appName`, `exit` (default `true` — `process.exit(1)` on failure), `throw` (throw instead), `silent` (no success line). Returns `{ ok, missing }`.

```sh
npx xeplr-check-env                          # checks ./env.required.js
npx xeplr-check-env --file ./env.list.js --name myapp
```

The same check at build time. It reads `process.env` only; load the `.env` first (e.g. `dotenv-cli`).

`gateRequiredEnv` is separate from any plain `requiredEnv` on purpose: only an app using the default gate needs `AUTH_URL`; one with `auth: false` or its own `middleware` would have to invent a value.

## Server-sent events

```js
var { sse } = require('@xeplr/base-apis')

app.get('/events', sse.createHandler({ validateTicket: ticketService.consumeTicket }))
sse.publish('user:42:jobs', { jobId, status })
```

```js
new EventSource('/events?ticket=<tk>&topics=user:me:jobs').onmessage = (e) => { const { topic, data } = JSON.parse(e.data) }
```

| | |
|---|---|
| `createHandler({ validateTicket, authorizeTopics? })` | production handler. `?ticket` required (401), `?topics` required (400). `validateTicket(ticket)` → `{ userId, scopes }` or `null` (401); throwing → 500. No authorised topic → 403 |
| `defaultAuthorizeTopics(payload, requested)` | rewrites `user:me:` to `user:<userId>:`, keeps topics matching a scope glob (default scope `user:me:*`), and **always drops another user's `user:<id>:` topic**, whatever the scopes say |
| `handler` | **no ticket, no topic check** — what `createApp({ sse: true })` mounts. For development and private networks |
| `publish(topic, data)` | writes to local subscribers and relays to every cluster worker |

A comment line is sent every 25 s so proxies do not drop idle streams; subscriptions are removed when the connection closes. The per-topic check exists because checking the ticket on connect is easy, while trusting client-supplied topics is how one user ends up subscribed to another's.

## Cluster

```js
runCluster({
  workers: 4,                 // default: CPU count
  respawn: true,              // default
  start: function () { createApp(3000, 'myapp', { … }) },
  onMessage: function (msg) { if (msg.type === 'cache-clear') clearCache() }
})

broadcast({ type: 'cache-clear' })   // from a worker: relayed to every other worker
```

## Environment

| variable | |
|---|---|
| `AUTH_URL` | the auth service base URL — **required** for the default gate |
| `UPLOAD_DIR` | upload destination when `upload.destination` is not given |
| `NODE_ENV` | anything but `production` puts the logger in dev mode |

## Tests

```sh
npm test
```

The auth gate against a stand-in auth service (refusal to boot, 401 / 503, public paths, caching, `X-New-Token`), SSE publish and subscribe, and ticket-authorised SSE.

## License

MIT
