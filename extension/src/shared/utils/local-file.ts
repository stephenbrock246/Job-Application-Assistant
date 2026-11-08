/**
 * Reads a file the browser downloaded, from disk. fetch() refuses file: URLs;
 * XMLHttpRequest reads them - once the user has turned on "Allow access to file
 * URLs" for the extension.
 */
export async function readLocalFile(path: string): Promise<Uint8Array> {
  const allowed = await new Promise<boolean>((resolve) => chrome.extension.isAllowedFileSchemeAccess(resolve))
  if (!allowed) {
    throw new Error(
      'To read downloaded files, open chrome://extensions > JobApply Assistant > Details and turn on "Allow access to file URLs".',
    )
  }
  const url = `file:///${path
    .replace(/\\/g, '/')
    .split('/')
    .map(encodeURIComponent)
    .join('/')
    .replace(/^([A-Za-z])%3A/, '$1:')}`
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('GET', url)
    request.responseType = 'arraybuffer'
    request.onload = () =>
      request.response ? resolve(new Uint8Array(request.response as ArrayBuffer)) : reject(new Error(`Could not read ${path}.`))
    request.onerror = () => reject(new Error(`Could not read ${path}.`))
    request.send()
  })
}
