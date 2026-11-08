/** Which of the files a chat created is the CV and which the cover letter, by name. */

/** The resume: never the cover letter; a name saying CV/resume first; PDF before Word; the newest of equals. */
export function pickResumeFile<T extends { name: string }>(files: T[]): T | null {
  const candidates = files.filter((f) => !/cover|letter|motivation/i.test(f.name))
  const score = (f: T) =>
    (/\b(cv|resume|r[eé]sum[eé]|curriculum)\b|_cv\b|cv[_.]/i.test(f.name) ? 4 : 0) +
    (/\.pdf$/i.test(f.name) ? 2 : /\.docx?$/i.test(f.name) ? 1 : 0)
  let best: T | null = null
  for (const file of candidates) if (!best || score(file) >= score(best)) best = file
  return best
}

/** The cover letter: PDF before Word, the newest of equals. */
export function pickCoverLetterFile<T extends { name: string }>(files: T[]): T | null {
  let best: T | null = null
  const score = (f: T) => (/\.pdf$/i.test(f.name) ? 2 : /\.docx?$/i.test(f.name) ? 1 : 0)
  for (const file of files.filter((f) => /cover|letter|motivation/i.test(f.name))) {
    if (!best || score(file) >= score(best)) best = file
  }
  return best
}
