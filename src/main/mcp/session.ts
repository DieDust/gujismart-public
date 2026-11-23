export async function runMcpDatabaseSession(options: {
  runTransport: (beforeLibraryTool: () => Promise<void>) => Promise<void>
  checkCredentialsPresent: () => void
  openDatabase: () => Promise<void>
  authorize: () => void
  prepareAuthorizedTools: () => void
  closeDatabase: () => void
}): Promise<void> {
  let startup: Promise<void> | undefined
  let databaseAttempted = false
  const closeOwnedDatabase = (): void => {
    if (!databaseAttempted) return
    databaseAttempted = false
    options.closeDatabase()
  }
  const beforeLibraryTool = (): Promise<void> => {
    startup ??= Promise.resolve().then(async () => {
      options.checkCredentialsPresent()
      databaseAttempted = true
      try {
        await options.openDatabase()
        options.authorize()
        options.prepareAuthorizedTools()
      } catch (error) {
        closeOwnedDatabase()
        throw error
      }
    })
    return startup
  }
  try {
    await options.runTransport(beforeLibraryTool)
  } finally {
    closeOwnedDatabase()
  }
}
