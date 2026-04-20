/**
 * Example: Department → Employees → MonthlySalaries API
 *
 * Demonstrates how to use xeplr-base-apis with xeplr-db
 * to create a full CRUD API with zero controller code.
 *
 * Run:
 *   DB_NAME=myapp DB_USER=root node examples/department-api.js
 */

var { createApp, genericRoute } = require('../index');
var { getConnection, bindModels } = require('@xeplr/db');
var BaseModel = require('@xeplr/db/lib/BaseModel');
var { authMiddleware } = require('@xeplr/auth');

// ── Database setup ──

var db = getConnection(process.env.DB_NAME || 'myapp');
bindModels(db);

// ── Models ──

class Department extends BaseModel {
  static get tableName() { return 'departments'; }

  static get relationMappings() {
    return {
      employees: {
        relation: BaseModel.HasManyRelation,
        modelClass: Employee,
        join: { from: 'departments.id', to: 'employees.departmentId' }
      }
    };
  }
}

class Employee extends BaseModel {
  static get tableName() { return 'employees'; }

  static get relationMappings() {
    return {
      monthlySalaries: {
        relation: BaseModel.HasManyRelation,
        modelClass: MonthlySalary,
        join: { from: 'employees.id', to: 'monthlySalaries.employeeId' }
      }
    };
  }
}

class MonthlySalary extends BaseModel {
  static get tableName() { return 'monthlySalaries'; }
}

// ── Routes ──

var deptRoutes = genericRoute(
  {
    key: 'department',
    model: Department,
    children: [
      {
        key: 'employees',
        model: Employee,
        children: [
          { key: 'monthlySalaries', model: MonthlySalary }
        ]
      }
    ]
  },
  {
    auth: authMiddleware   // all routes require authentication
  }
);

// ── Start server ──

var port = process.env.PORT || 3000;

createApp(port, 'department-api', {
  routes: {
    '/api/departments': deptRoutes
  }
});

/**
 * Generated endpoints:
 *
 *   GET  /api/departments              → list all departments (paginated, with employees + salaries)
 *   GET  /api/departments/:id          → get single department (with employees + salaries)
 *   POST /api/departments/save         → save changeset (transactional)
 *   POST /api/departments/delete       → soft delete by ids
 *
 * ── Example: GET /api/departments ──
 *
 *   Response:
 *   {
 *     "code": "SUCCESS",
 *     "message": "Success",
 *     "dataArray": [
 *       {
 *         "id": "a1b2c3...",
 *         "name": "Engineering",
 *         "budget": 500000,
 *         "isActive": true,
 *         "employees": [
 *           {
 *             "id": "d4e5f6...",
 *             "name": "Alice",
 *             "role": "Lead",
 *             "departmentId": "a1b2c3...",
 *             "monthlySalaries": [
 *               { "id": "g7h8i9...", "month": "2024-01", "amount": 10000, "employeeId": "d4e5f6..." }
 *             ]
 *           }
 *         ]
 *       }
 *     ],
 *     "pagination": { "page": 1, "limit": 50, "total": 4, "totalPages": 1 }
 *   }
 *
 * ── Example: POST /api/departments/save ──
 *
 *   Request body (changeset from xeplr-ui-table onCommit):
 *   [
 *     {
 *       "id": "a1b2c3...",
 *       "name": "Engineering Dept",
 *       "employees": [
 *         { "name": "New Hire", "role": "Junior" },
 *         { "id": "d4e5f6...", "role": "Senior" },
 *         { "id": "x1y2z3...", "deleted": true }
 *       ]
 *     },
 *     { "name": "New Department" },
 *     { "id": "old123...", "deleted": true }
 *   ]
 *
 *   Rules:
 *     - No id           → insert (generates 25-char hex id)
 *     - Has id          → patch (only the fields provided)
 *     - deleted: true   → soft delete (isActive = false)
 *     - All in one transaction — commit or rollback
 *
 * ── Example: POST /api/departments/delete ──
 *
 *   Request body:
 *   { "ids": ["a1b2c3...", "d4e5f6..."] }
 *
 *   Soft deletes all listed ids (isActive = false).
 */
