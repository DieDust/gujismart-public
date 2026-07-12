const assert = require('assert')
const {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} = require('fs')
const os = require('os')
const path = require('path')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'gujismart-file-capability-'))
const bundlePath = path.join(tempRoot, 'file-capabilities.cjs')

async function expectCode(operation, expectedCode) {
  try {
    await operation()
  } catch (error) {
    assert.strictEqual(error.code, expectedCode, `expected ${expectedCode}, received ${error.code || error.message}`)
    return
  }
  throw new Error(`expected ${expectedCode}`)
}

async function main() {
  buildSync({
    entryPoints: [path.join(root, 'src', 'main', 'file-capabilities.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundlePath,
    logLevel: 'silent',
  })

  const { FileCapabilityService } = require(bundlePath)
  let now = 1_000
  let nextId = 0
  const service = new FileCapabilityService({
    defaultTtlMs: 100,
    maxActive: 64,
    now: () => now,
    idFactory: () => `grant-${++nextId}`,
  })
  const filesRoot = path.join(tempRoot, 'files')
  const firstFile = path.join(filesRoot, 'first.pdf')
  const secondFile = path.join(filesRoot, 'second.pdf')
  const directory = path.join(filesRoot, 'directory')
  mkdirSync(directory, { recursive: true })
  writeFileSync(firstFile, 'first')
  writeFileSync(secondFile, 'second')

  const [firstGrant] = await service.issueTrustedPaths({
    ownerId: 11,
    purpose: 'document-import',
    paths: [firstFile],
    kind: 'file',
    consumeMode: 'once',
  })
  assert.deepStrictEqual(firstGrant, {
    grantId: 'grant-1',
    displayName: 'first.pdf',
    kind: 'file',
    expiresAt: 1100,
  })
  assert.strictEqual(await service.consumeFile(11, firstGrant.grantId, 'document-import'), path.resolve(firstFile))
  await expectCode(() => service.consumeFile(11, firstGrant.grantId, 'document-import'), 'CAPABILITY_ALREADY_CONSUMED')

  const [purposeGrant] = await service.issueTrustedPaths({
    ownerId: 11,
    purpose: 'pdf-restore',
    paths: [secondFile],
    kind: 'file',
  })
  await expectCode(() => service.consumeFile(12, purposeGrant.grantId, 'pdf-restore'), 'CAPABILITY_OWNER_MISMATCH')
  await expectCode(() => service.consumeFile(11, purposeGrant.grantId, 'document-import'), 'CAPABILITY_PURPOSE_MISMATCH')
  await expectCode(() => service.useDirectory(11, purposeGrant.grantId, 'pdf-restore'), 'CAPABILITY_KIND_MISMATCH')
  await expectCode(() => service.consumeFile(11, 'missing', 'pdf-restore'), 'CAPABILITY_UNKNOWN')

  const [directoryGrant] = await service.issueTrustedPaths({
    ownerId: 11,
    purpose: 'pdf-repository',
    paths: [directory],
    kind: 'directory',
    consumeMode: 'session',
  })
  assert.strictEqual(await service.useDirectory(11, directoryGrant.grantId, 'pdf-repository'), path.resolve(directory))
  assert.strictEqual(await service.useDirectory(11, directoryGrant.grantId, 'pdf-repository'), path.resolve(directory))

  now = 1_101
  await expectCode(() => service.useDirectory(11, directoryGrant.grantId, 'pdf-repository'), 'CAPABILITY_EXPIRED')
  now = 1_000

  const [revokedGrant] = await service.issueTrustedPaths({
    ownerId: 21,
    purpose: 'document-import',
    paths: [secondFile],
    kind: 'file',
  })
  service.revoke(revokedGrant.grantId)
  await expectCode(() => service.consumeFile(21, revokedGrant.grantId, 'document-import'), 'CAPABILITY_UNKNOWN')

  const [ownerGrant] = await service.issueTrustedPaths({
    ownerId: 22,
    purpose: 'document-import',
    paths: [secondFile],
    kind: 'file',
  })
  service.revokeOwner(22)
  await expectCode(() => service.consumeFile(22, ownerGrant.grantId, 'document-import'), 'CAPABILITY_UNKNOWN')

  const replacementPath = path.join(filesRoot, 'replace.pdf')
  writeFileSync(replacementPath, 'before')
  const [replacementGrant] = await service.issueTrustedPaths({
    ownerId: 31,
    purpose: 'document-import',
    paths: [replacementPath],
    kind: 'file',
  })
  unlinkSync(replacementPath)
  writeFileSync(replacementPath, 'after replacement with different bytes')
  await expectCode(() => service.consumeFile(31, replacementGrant.grantId, 'document-import'), 'CAPABILITY_TARGET_CHANGED')

  const missingPath = path.join(filesRoot, 'missing-after-grant.pdf')
  writeFileSync(missingPath, 'temporary')
  const [missingGrant] = await service.issueTrustedPaths({
    ownerId: 32,
    purpose: 'document-import',
    paths: [missingPath],
    kind: 'file',
  })
  unlinkSync(missingPath)
  await expectCode(() => service.consumeFile(32, missingGrant.grantId, 'document-import'), 'CAPABILITY_TARGET_MISSING')

  const linkPath = path.join(filesRoot, 'linked.pdf')
  let linkCoverage = 'skipped'
  try {
    symlinkSync(secondFile, linkPath, 'file')
    linkCoverage = 'file-symlink'
    await expectCode(() => service.issueTrustedPaths({
      ownerId: 40,
      purpose: 'document-import',
      paths: [linkPath],
      kind: 'file',
    }), 'CAPABILITY_SYMLINK_REJECTED')
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES' && !String(error.message).includes('privilege')) throw error
    const junctionPath = path.join(filesRoot, 'linked-directory')
    try {
      symlinkSync(directory, junctionPath, 'junction')
      linkCoverage = 'directory-junction'
      await expectCode(() => service.issueTrustedPaths({
        ownerId: 40,
        purpose: 'pdf-repository',
        paths: [junctionPath],
        kind: 'directory',
      }), 'CAPABILITY_SYMLINK_REJECTED')
    } catch (junctionError) {
      if (junctionError.code !== 'EPERM'
        && junctionError.code !== 'EACCES'
        && !String(junctionError.message).includes('privilege')) throw junctionError
      console.warn(`File capability regression: symlink/junction cases skipped (${junctionError.code || junctionError.message})`)
    }
  }

  const batchOne = path.join(filesRoot, 'batch-1.pdf')
  const batchTwo = path.join(filesRoot, 'batch-2.pdf')
  writeFileSync(batchOne, 'batch one')
  writeFileSync(batchTwo, 'batch two')
  const batchGrants = await service.issueTrustedPaths({
    ownerId: 50,
    purpose: 'document-import',
    paths: [batchOne, batchTwo],
    kind: 'file',
  })
  const batch = await service.beginFileBatch(50, batchGrants.map((item) => item.grantId), 'document-import')
  assert.strictEqual(batch.entries.length, 2)
  await expectCode(
    () => service.beginFileBatch(50, [batchGrants[0].grantId], 'document-import'),
    'CAPABILITY_ALREADY_LOCKED',
  )
  service.settleFileBatch(batch.leaseId, [batchGrants[0].grantId])
  await expectCode(() => service.consumeFile(50, batchGrants[0].grantId, 'document-import'), 'CAPABILITY_ALREADY_CONSUMED')
  assert.strictEqual(await service.consumeFile(50, batchGrants[1].grantId, 'document-import'), path.resolve(batchTwo))

  const atomicGrants = await service.issueTrustedPaths({
    ownerId: 60,
    purpose: 'document-import',
    paths: [batchOne],
    kind: 'file',
  })
  await expectCode(
    () => service.beginFileBatch(60, [atomicGrants[0].grantId, 'unknown-grant'], 'document-import'),
    'CAPABILITY_UNKNOWN',
  )
  assert.strictEqual(await service.consumeFile(60, atomicGrants[0].grantId, 'document-import'), path.resolve(batchOne))

  assert.strictEqual(service.sweepExpired(10_000) > 0, true)
  assert.strictEqual(service.activeCount, 0)

  const capacityService = new FileCapabilityService({
    defaultTtlMs: 100,
    maxActive: 1,
    now: () => now,
    idFactory: () => `capacity-${++nextId}`,
  })
  const [capacityGrant] = await capacityService.issueTrustedPaths({
    ownerId: 70,
    purpose: 'document-import',
    paths: [firstFile],
    kind: 'file',
  })
  await expectCode(() => capacityService.issueTrustedPaths({
    ownerId: 70,
    purpose: 'document-import',
    paths: [secondFile],
    kind: 'file',
  }), 'CAPABILITY_BATCH_LIMIT')
  assert.strictEqual(await capacityService.consumeFile(70, capacityGrant.grantId, 'document-import'), path.resolve(firstFile))
  assert.strictEqual(capacityService.activeCount, 0, 'consumed once grant should release active capacity')
  await expectCode(
    () => capacityService.consumeFile(70, capacityGrant.grantId, 'document-import'),
    'CAPABILITY_ALREADY_CONSUMED',
  )
  for (let index = 0; index < 4; index += 1) {
    const [grant] = await capacityService.issueTrustedPaths({
      ownerId: 70,
      purpose: 'document-import',
      paths: [secondFile],
      kind: 'file',
    })
    assert.strictEqual(await capacityService.consumeFile(70, grant.grantId, 'document-import'), path.resolve(secondFile))
    assert.strictEqual(capacityService.activeCount, 0)
  }

  now = 2_000
  const leaseService = new FileCapabilityService({
    defaultTtlMs: 100,
    leaseTtlMs: 200,
    maxActive: 2,
    now: () => now,
    idFactory: () => `lease-test-${++nextId}`,
  })
  const [abortGrant] = await leaseService.issueTrustedPaths({
    ownerId: 80,
    purpose: 'document-import',
    paths: [batchOne],
    kind: 'file',
  })
  const abortBatch = await leaseService.beginFileBatch(80, [abortGrant.grantId], 'document-import')
  await expectCode(
    () => leaseService.settleFileBatch(abortBatch.leaseId, ['not-in-this-lease']),
    'CAPABILITY_LEASE_MISMATCH',
  )
  await expectCode(
    () => leaseService.consumeFile(80, abortGrant.grantId, 'document-import'),
    'CAPABILITY_ALREADY_LOCKED',
  )
  leaseService.abortFileBatch(abortBatch.leaseId)
  assert.strictEqual(await leaseService.consumeFile(80, abortGrant.grantId, 'document-import'), path.resolve(batchOne))

  const [lockedGrant] = await leaseService.issueTrustedPaths({
    ownerId: 81,
    purpose: 'document-import',
    paths: [batchTwo],
    kind: 'file',
  })
  const lockedBatch = await leaseService.beginFileBatch(81, [lockedGrant.grantId], 'document-import')
  now = 2_101
  leaseService.sweepExpired()
  assert.strictEqual(leaseService.activeCount, 1, 'locked grant should remain active until its lease expires')
  leaseService.settleFileBatch(lockedBatch.leaseId, [lockedGrant.grantId])
  assert.strictEqual(leaseService.activeCount, 0, 'settled once grant should release active capacity')

  now = 3_000
  const [expiredSettleGrant] = await leaseService.issueTrustedPaths({
    ownerId: 82,
    purpose: 'document-import',
    paths: [batchOne],
    kind: 'file',
  })
  const expiredSettleBatch = await leaseService.beginFileBatch(82, [expiredSettleGrant.grantId], 'document-import')
  now = 3_201
  await expectCode(
    () => leaseService.settleFileBatch(expiredSettleBatch.leaseId, [expiredSettleGrant.grantId]),
    'CAPABILITY_LEASE_EXPIRED',
  )

  now = 4_000
  const [expiredAbortGrant] = await leaseService.issueTrustedPaths({
    ownerId: 83,
    purpose: 'document-import',
    paths: [batchTwo],
    kind: 'file',
  })
  const expiredAbortBatch = await leaseService.beginFileBatch(83, [expiredAbortGrant.grantId], 'document-import')
  now = 4_201
  await expectCode(
    () => leaseService.abortFileBatch(expiredAbortBatch.leaseId),
    'CAPABILITY_LEASE_EXPIRED',
  )

  now = 5_000
  const renewableLeaseService = new FileCapabilityService({
    defaultTtlMs: 100,
    leaseTtlMs: 100,
    maxLeaseTtlMs: 500,
    maxActive: 2,
    now: () => now,
    idFactory: () => `renewable-lease-${++nextId}`,
  })
  const [renewedGrant] = await renewableLeaseService.issueTrustedPaths({
    ownerId: 84,
    purpose: 'document-import',
    paths: [batchOne],
    kind: 'file',
  })
  const renewedBatch = await renewableLeaseService.beginFileBatch(84, [renewedGrant.grantId], 'document-import', 100)
  now = 5_090
  renewableLeaseService.renewFileBatch(renewedBatch.leaseId, 200)
  now = 5_150
  renewableLeaseService.settleFileBatch(renewedBatch.leaseId, [renewedGrant.grantId])

  const [unrenewedGrant] = await renewableLeaseService.issueTrustedPaths({
    ownerId: 85,
    purpose: 'document-import',
    paths: [batchTwo],
    kind: 'file',
  })
  const unrenewedBatch = await renewableLeaseService.beginFileBatch(85, [unrenewedGrant.grantId], 'document-import', 100)
  now = 5_251
  await expectCode(
    () => renewableLeaseService.settleFileBatch(unrenewedBatch.leaseId, [unrenewedGrant.grantId]),
    'CAPABILITY_LEASE_EXPIRED',
  )

  console.log(`File capability regression passed (link=${linkCoverage})`)
}

main().finally(() => {
  rmSync(tempRoot, { recursive: true, force: true })
}).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
