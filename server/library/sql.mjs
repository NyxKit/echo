// Reusing bounded prepared statements avoids retaining thousands of native
// statement objects until GC during a large transaction. SQL is internal only.
export function cacheStatements(database) {
  const statements = new Map()
  return new Proxy(database, {
    get(target, key) {
      if (key === 'prepare') return sql => {
        let statement = statements.get(sql)
        if (!statement) {
          statement = target.prepare(sql)
          if (statements.size >= 256) statements.delete(statements.keys().next().value)
          statements.set(sql, statement)
        }
        return statement
      }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
