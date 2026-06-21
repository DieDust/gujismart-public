const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const backupSource = fs.readFileSync(path.join(root, 'src/main/backup.ts'), 'utf8')

function assertIncludes(needle, label) {
  if (!backupSource.includes(needle)) {
    throw new Error(`${label}: missing ${needle}`)
  }
}

assertIncludes("return readSetting('auto_backup_include_storage', 'true') !== 'false'", 'auto backup should include storage by default for enterprise data')
assertIncludes('function copyStorageForBackup', 'backup should centralize storage copy behavior')
assertIncludes("getStoragePagePayloadsDir(sourceStorageDir)", 'lightweight backups should still include externalized page payloads')
assertIncludes("replaceManagedDirectory(dataDir, 'storage', getBackupStorageDir(backupDir))", 'backup restore should replace storage to match the imported database')
assertIncludes("writeSetting('auto_backup_include_storage', 'true')", 'auto backup compaction should not switch future backups to db-only mode')
assertIncludes('includesPagePayloads', 'backup manifest should record whether externalized page payloads are present')
assertIncludes('function backupSqliteHasExternalPayloadRefs', 'backup import should detect externalized page payload refs in sqlite backups')
assertIncludes('function collectBackupExternalPayloadRefs', 'backup import should collect referenced external page payload files')
assertIncludes('function resolveBackupPayloadRefPath', 'backup import should resolve external payload refs safely inside the backup directory')
assertIncludes('function validateBackupPayloadCompleteness', 'backup import should validate referenced external page payload files are present')
assertIncludes('validateBackupPayloadCompleteness(backupDir)', 'backup directory validation should reject incomplete enterprise storage backups')
assertIncludes('for (const ref of refs)', 'backup validation should check every referenced external payload file')
assertIncludes('备份不完整', 'incomplete enterprise storage backups should fail with a clear localized error')

console.log('Backup storage regression checks passed.')
