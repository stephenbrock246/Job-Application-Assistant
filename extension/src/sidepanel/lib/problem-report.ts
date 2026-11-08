/**
 * The downloadable problem report: one .zip with everything needed to reproduce
 * what went wrong.
 *
 *   README.txt            what is inside, and that it holds personal details
 *   summary.txt           one line per problem, newest first
 *   timeline.txt / .json  everything the extension did, step by step
 *   problems/NN_company_kind/
 *     problem.json        what failed, the session, the steps before it
 *     screenshot.jpg      the job tab at that moment (when it was visible)
 *     page.html           a copy of the page, typed values included
 *     fields.json         every field the scanner saw, with its value
 */

import { strToU8, zipSync, type Zippable } from 'fflate'
import { flightLogSlot, getIncidentDetail, incidentsSlot } from '@/storage/diagnostics'
import { base64ToBytes } from '@/shared/utils/bytes'
import type { IncidentDetail, IncidentSummary, LogEvent } from '@/shared/types/diagnostics'

export interface ReportInput {
  incidents: IncidentSummary[]
  details: Map<string, IncidentDetail>
  events: LogEvent[]
  version: string
  userAgent: string
  generatedAt: number
}

/** The report's files, by path. Pure, so it can be checked without Chrome. */
export function buildReportFiles(input: ReportInput): Zippable {
  const files: Zippable = {}
  const newestFirst = [...input.incidents].sort((a, b) => b.lastAt - a.lastAt)
  const folders = new Map<string, string>()
  newestFirst.forEach((incident, index) => {
    const name = [String(index + 1).padStart(2, '0'), slug(incident.company || 'no-job'), slug(incident.kind)].join('_')
    folders.set(incident.id, `problems/${name}`)
  })

  files['README.txt'] = strToU8(readme(input))
  files['summary.txt'] = strToU8(summary(newestFirst, folders))
  files['timeline.txt'] = strToU8(input.events.map(timelineLine).join('\n'))
  files['timeline.json'] = strToU8(JSON.stringify(input.events, null, 1))

  for (const incident of newestFirst) {
    const folder = folders.get(incident.id)!
    const detail = input.details.get(incident.id)
    files[`${folder}/problem.json`] = strToU8(
      JSON.stringify(
        {
          ...incident,
          when: new Date(incident.at).toISOString(),
          data: detail?.data,
          session: detail?.session,
          stepsBefore: detail?.timeline.map(timelineLine),
        },
        null,
        1,
      ),
    )
    const jpeg = detail?.screenshot ? dataUrlBytes(detail.screenshot) : null
    // Already compressed: stored as-is, which is also much faster.
    if (jpeg) files[`${folder}/screenshot.jpg`] = [jpeg, { level: 0 }]
    if (detail?.snapshot) {
      files[`${folder}/page.html`] = strToU8(detail.snapshot.html)
      files[`${folder}/fields.json`] = strToU8(JSON.stringify(detail.snapshot.fields, null, 1))
    }
  }
  return files
}

/** Reads the records, zips them, and saves the .zip to Downloads/JobApply/Problem reports/. */
export async function downloadProblemReport(): Promise<string> {
  const [incidents, events] = await Promise.all([incidentsSlot.get(), flightLogSlot.get()])
  const details = new Map<string, IncidentDetail>()
  for (const incident of incidents) {
    const detail = await getIncidentDetail(incident.id)
    if (detail) details.set(incident.id, detail)
  }

  const generatedAt = Date.now()
  const zip = zipSync(
    buildReportFiles({
      incidents,
      details,
      events,
      version: chrome.runtime.getManifest().version,
      userAgent: navigator.userAgent,
      generatedAt,
    }),
  )

  const stamp = new Date(generatedAt).toISOString().slice(0, 16).replace('T', '_').replace(':', '-')
  const fileName = `JobApply-problems-${stamp}.zip`
  const url = URL.createObjectURL(new Blob([zip.slice()], { type: 'application/zip' }))
  try {
    await chrome.downloads.download({
      url,
      filename: `JobApply/Problem reports/${fileName}`,
      conflictAction: 'uniquify',
      saveAs: false,
    })
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }
  return fileName
}

// ---------------------------------------------------------------------------

function readme(input: ReportInput): string {
  return [
    'JobApply Assistant - problem report',
    '',
    `Created ${new Date(input.generatedAt).toString()}`,
    `Extension version ${input.version}`,
    `Browser ${input.userAgent}`,
    '',
    'summary.txt    - one line per problem, newest first',
    'timeline.txt   - every step the extension took, in order',
    'problems/      - one folder per problem:',
    '                 screenshot.jpg (the job page at that moment),',
    '                 page.html (a copy of the page - open it in Chrome),',
    '                 fields.json (every field found, with its value),',
    '                 problem.json (what failed and the steps before it)',
    '',
    'PRIVATE: this report contains what was typed into job forms - your name,',
    'contact details and answers. Share it only with the person fixing the extension.',
  ].join('\n')
}

function summary(incidents: IncidentSummary[], folders: Map<string, string>): string {
  if (!incidents.length) return 'No problems recorded.\n'
  const lines = [`${incidents.length} problem${incidents.length === 1 ? '' : 's'} recorded.`, '']
  for (const incident of incidents) {
    const job = incident.company ? `${incident.company}${incident.position ? ` - ${incident.position}` : ''}` : 'no job open'
    const times = incident.count > 1 ? ` x${incident.count}` : ''
    lines.push(
      `${time(incident.lastAt)}  [${incident.manual ? 'reported by you' : incident.kind}${times}]  ${job}`,
      `    ${incident.message}`,
      ...(incident.note ? [`    Your note: ${incident.note}`] : []),
      ...(incident.url ? [`    Page: ${incident.url}${incident.adapter ? ` (handled as: ${incident.adapter})` : ''}`] : []),
      `    From: ${incident.origin}  ·  Files: ${folders.get(incident.id)}${incident.hasScreenshot ? '' : `  ·  no screenshot${incident.screenshotNote ? ` (${incident.screenshotNote})` : ''}`}`,
      '',
    )
  }
  return lines.join('\n')
}

function timelineLine(event: LogEvent): string {
  const level = event.level === 'info' ? '    ' : event.level === 'warn' ? 'WARN' : 'ERR '
  const data = event.data === undefined ? '' : `  ${JSON.stringify(event.data)}`
  return `${time(event.at)} ${level} ${event.kind}: ${event.message}${event.url ? `  <${event.url}>` : ''}${data}`
}

function time(at: number): string {
  const date = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'x'
}

function dataUrlBytes(dataUrl: string): Uint8Array | null {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return null
  try {
    return base64ToBytes(dataUrl.slice(comma + 1))
  } catch {
    return null
  }
}
