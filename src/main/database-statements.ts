import type Database from 'better-sqlite3'

const MAX_STATEMENTS = 256
const MAX_SQL_LENGTH = 16_384
const caches = new WeakMap<Database.Database, Map<string, Database.Statement>>()

// Cache compiled SQL only, never rows or bound values. Each connection owns its cache.
export function prepareCachedStatement(database: Database.Database, sql: string): Database.Statement {
  if (sql.length > MAX_SQL_LENGTH) return database.prepare(sql)
  let cache = caches.get(database)
  if (!cache) { cache = new Map(); caches.set(database, cache) }
  const existing = cache.get(sql)
  if (existing && !existing.busy) {
    cache.delete(sql)
    cache.set(sql, existing)
    return existing
  }
  const statement = database.prepare(sql)
  // A recursive SQLite callback must not reuse a currently executing statement.
  if (existing?.busy) return statement
  cache.set(sql, statement)
  if (cache.size > MAX_STATEMENTS) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  return statement
}

export function clearPreparedStatements(database: Database.Database): void {
  caches.delete(database)
}
