/**
 * CSV source check.
 *
 * Exercises the real parser, importer, row writer and exporter against the awkward
 * cases that actually appear in exported job spreadsheets.
 *
 *   npm run check:csv
 *
 * The property that matters most is round-tripping: importing a file, writing one
 * row, and exporting must change exactly that row and leave every other byte of
 * the user's document alone.
 */

// A minimal in-memory chrome.storage.local, since the CSV source persists through it.
const store = new Map<string, unknown>()
;(globalThis as Record<string, unknown>).chrome = {
  storage: {
    local: {
      get: async (key: string) => (store.has(key) ? { [key]: store.get(key) } : {}),
      set: async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) store.set(key, value)
      },
      remove: async (key: string) => void store.delete(key),
    },
    onChanged: { addListener: () => {}, removeListener: () => {} },
  },
}

const { parseCsv, serializeCsv } = await import('../extension/src/jobsource/csv/csv.ts')
const { CsvJobSource, importCsv, exportCsv } = await import(
  '../extension/src/jobsource/csv/csv.source.ts'
)

const failures: string[] = []
function expect(condition: boolean, message: string) {
  if (!condition) failures.push(message)
}
function expectEqual(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) failures.push(`${message}\n      expected ${b}\n      actual   ${a}`)
}

console.log('\n--- Parser ---------------------------------------------------\n')

// Quoted fields containing the delimiter, quotes and newlines.
{
  const text = 'a,b,c\r\n"x,1","he said ""hi""","line1\nline2"\r\n'
  const parsed = parseCsv(text)
  expectEqual(parsed.records.length, 2, 'quoted CSV should parse to 2 records')
  expectEqual(
    parsed.records[1],
    ['x,1', 'he said "hi"', 'line1\nline2'],
    'quoted fields should preserve delimiters, escaped quotes and embedded newlines',
  )
  expectEqual(parsed.eol, '\r\n', 'CRLF should be detected')
  console.log('quoted fields       ok')
}

// UTF-8 BOM.
{
  const parsed = parseCsv('﻿Date,Job Link\n1/1,https://x\n')
  expect(parsed.hadBom, 'BOM should be detected')
  expectEqual(parsed.records[0], ['Date', 'Job Link'], 'BOM should be stripped from the first header')
  console.log('utf-8 bom           ok')
}

// Delimiter sniffing.
{
  expectEqual(parseCsv('a;b;c\n1;2;3\n').delimiter, ';', 'semicolons should be detected')
  expectEqual(parseCsv('a\tb\tc\n1\t2\t3\n').delimiter, '\t', 'tabs should be detected')
  // A prose cell full of commas must not beat a consistent semicolon layout.
  expectEqual(
    parseCsv('a;b\n"one, two, three, four";x\n"five, six, seven";y\n').delimiter,
    ';',
    'a comma-heavy prose column should not fool the sniffer',
  )
  console.log('delimiter sniffing  ok')
}

// Round trip without modification.
{
  const original = 'Date,Job Link,Company\r\n12/8,"https://x?a=1,2",Acme\r\n'
  const parsed = parseCsv(original)
  const out = serializeCsv(parsed.records, parsed.delimiter, parsed.eol, parsed.hadBom)
  expectEqual(out, original, 'parse -> serialize should reproduce the original bytes')
  console.log('round trip          ok')
}

// A trailing newline must not create a phantom row.
{
  const parsed = parseCsv('a,b\n1,2\n')
  expectEqual(parsed.records.length, 2, 'a trailing newline should not produce an empty record')
  console.log('trailing newline    ok')
}

console.log('\n--- Import / write / export ----------------------------------\n')

// The spec's example sheet, with a preamble line above the header, a missing
// Applied Date / Resume column, and a quoted field containing a comma.
const fixture = [
  'My job search 2026',
  'Date,Job Link,Company,Position,Status,Other',
  '12/8,https://boards.acme.com/1,Company A,Full Stack Developer,Applied',
  '12/8,https://jobs.lever.co/b/2,Company B,Frontend Developer,Failed,"Required: Russian, C1"',
  '12/9,https://boards.greenhouse.io/c/3,Company C,Backend Developer,',
  '12/9,https://ashbyhq.com/d/4,Company D,Platform Engineer,In Progress',
].join('\r\n')

const imported = await importCsv({
  fileName: 'jobs.csv',
  text: fixture,
  addMissingColumns: true,
  hasFileHandle: false,
})

console.log(`imported ${imported.jobCount} jobs from ${imported.fileName}`)
console.log(`headers: ${imported.headers.join(' | ')}`)
console.log(`added columns: ${imported.addedColumns.join(', ') || '(none)'}`)

expectEqual(imported.jobCount, 4, 'all four data rows should be read as jobs')
expectEqual(
  imported.addedColumns,
  ['Applied Date', 'Resume'],
  'missing writable columns should be appended',
)
expectEqual(imported.missingColumns, [], 'no writable column should remain missing')

const source = new CsvJobSource()
const { jobs } = await source.readJobs()

console.log('')
for (const job of jobs) {
  console.log(
    `  row ${String(job.rowNumber).padEnd(3)} ${job.company.padEnd(12)} ${job.status.padEnd(12)} ${job.jobLink}`,
  )
}

// The header sits on record index 1, so the first job is row 3.
expectEqual(jobs[0]?.rowNumber, 3, 'row numbers should account for the preamble line')
expectEqual(jobs[2]?.status, 'READY', 'a blank Status should normalise to READY')
expectEqual(jobs[3]?.status, 'IN_PROGRESS', '"In Progress" should normalise to IN_PROGRESS')
expectEqual(
  jobs[1]?.other,
  'Required: Russian, C1',
  'a quoted field containing a comma should survive import',
)

// --- Write one row, the way Done does.
const target = jobs[2]!
expect(await source.verifyRow(target.rowNumber, target.jobLink), 'verifyRow should match its own row')
expect(
  !(await source.verifyRow(target.rowNumber, 'https://example.com/other')),
  'verifyRow should reject a row whose link no longer matches',
)

await source.updateRow(target.rowNumber, {
  status: 'Applied',
  appliedDate: '12/10',
  resume: 'Company_C_Backend_Developer_Resume.pdf',
})

const status = await source.getStatus()
expectEqual(status.unsavedChanges, 1, 'one write should register one unsaved change')
expect(status.canWriteBack, 'every writable column should be mapped after import')

const exported = await exportCsv()
console.log('\nExported file:\n')
console.log(
  exported.text
    .split('\r\n')
    .map((line) => `  ${line}`)
    .join('\n'),
)

const originalLines = fixture.split('\r\n')
const exportedLines = exported.text.trimEnd().split('\r\n')

// The preamble must be untouched, not padded out to the table's width.
expectEqual(exportedLines[0], originalLines[0], 'the preamble line should be preserved verbatim')

// Compare record by record. Only the header (which gained two columns) and the one
// row we wrote may differ; every other record must be byte-identical.
const beforeRecords = parseCsv(fixture).records
const afterRecords = parseCsv(exported.text).records
const writtenIndex = target.rowNumber - 1

expectEqual(
  afterRecords.length,
  beforeRecords.length,
  'exporting should not add or drop any records',
)

const changed: number[] = []
for (let i = 0; i < beforeRecords.length; i += 1) {
  if (JSON.stringify(beforeRecords[i]) !== JSON.stringify(afterRecords[i])) changed.push(i)
}
expectEqual(
  changed,
  [1, writtenIndex],
  'only the header row and the written row should differ from the original',
)

const writtenRow = afterRecords[writtenIndex] ?? []
expect(writtenRow.includes('Applied'), 'the written row should carry the new Status')
expect(writtenRow.includes('12/10'), 'the written row should carry the Applied Date')
expect(
  writtenRow.includes('Company_C_Backend_Developer_Resume.pdf'),
  'the written row should carry the Resume filename',
)

expect(
  exportedLines[3]?.includes('"Required: Russian, C1"') === true,
  'a field containing a comma should be re-quoted on export',
)

// Re-importing what we exported must produce the same jobs, one of them now Applied.
const reimported = await importCsv({
  fileName: 'jobs.csv',
  text: exported.text,
  addMissingColumns: true,
  hasFileHandle: false,
})
expectEqual(reimported.jobCount, 4, 'a re-import of the exported file should find the same jobs')
expectEqual(reimported.addedColumns, [], 'a re-import should not need to add any columns again')

const afterJobs = (await new CsvJobSource().readJobs()).jobs
expectEqual(afterJobs[2]?.status, 'APPLIED', 'the written row should read back as APPLIED')
expectEqual(afterJobs[2]?.appliedDate, '12/10', 'the Applied Date should read back')
expectEqual(
  afterJobs[0]?.status,
  'APPLIED',
  'an untouched row should keep the status it already had',
)

console.log('')
if (failures.length) {
  for (const failure of failures) console.error(`FAIL  ${failure}`)
  console.error(`\n${failures.length} check(s) failed.\n`)
  process.exit(1)
}
console.log('All CSV checks passed.\n')
