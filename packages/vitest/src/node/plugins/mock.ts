import type { Plugin } from 'vite'
import MagicString from 'magic-string'
import { getCallLastIndex } from '../../utils'

const mockRegexp = /^ *\b((?:vitest|vi)\s*.\s*mock\(["`'\s]+(.*[@\w_-]+)["`'\s]+)[),]{1};?/gm
const pathRegexp = /\b(?:vitest|vi)\s*.\s*(unmock|importActual|importMock)\(["`'\s](.*[@\w_-]+)["`'\s]\);?/mg
const vitestRegexp = /import {[^}]*}.*(?=["'`]vitest["`']).*/gm

export const MocksPlugin = (): Plugin => {
  return {
    name: 'vitest:mock-plugin',
    enforce: 'post',
    async transform(code, id) {
      let m: MagicString | undefined
      const matchAll = code.matchAll(pathRegexp)

      for (const match of matchAll) {
        const [line, method, modulePath] = match
        const filepath = await this.resolve(modulePath, id)
        m ??= new MagicString(code)
        const start = match.index || 0
        const end = start + line.length

        const overwrite = `${getMethodCall(method, filepath?.id || modulePath, modulePath)});`

        m.overwrite(start, end, overwrite)
      }

      const mocks = code.matchAll(mockRegexp)

      for (const mockResult of mocks) {
        // we need to parse parsed string because factory may contain importActual
        const lastIndex = getMockLastIndex(code.slice(mockResult.index!))
        const [, declaration, path] = mockResult

        if (lastIndex === null) continue

        const startIndex = mockResult.index!

        const { insideComment, insideString } = getIndexStatus(code, startIndex)

        if (insideComment || insideString)
          continue

        const endIndex = startIndex + lastIndex

        const filepath = await this.resolve(path, id)

        m ??= new MagicString(code)

        const overwrite = getMethodCall('mock', filepath?.id || path, path)

        m.overwrite(startIndex, startIndex + declaration.length, overwrite)
        m.prepend(`${m.slice(startIndex, endIndex)}\n`)
        m.remove(startIndex, endIndex)
      }

      if (m) {
        // hoist vitest imports in case it was used inside vi.mock factory #425
        const vitestImports = code.matchAll(vitestRegexp)
        for (const match of vitestImports) {
          const indexStart = match.index!
          const indexEnd = match[0].length + indexStart
          m.remove(indexStart, indexEnd)
          m.prepend(`${match[0]}\n`)
        }
        return {
          code: m.toString(),
          map: m.generateMap({ hires: true }),
        }
      }
    },
  }
}

function getMockLastIndex(code: string): number | null {
  const index = getCallLastIndex(code)
  if (index === null)
    return null
  return code[index + 1] === ';' ? index + 2 : index + 1
}

function getMethodCall(method: string, actualPath: string, importPath: string) {
  let nodeModule = 'null'
  if (actualPath.includes('/node_modules/'))
    nodeModule = `"${importPath}"`

  return `__vitest__${method}__("${actualPath}", ${nodeModule}`
}

function getIndexStatus(code: string, from: number) {
  let index = 0
  let commentStarted = false
  let commentEnded = true
  let multilineCommentStarted = false
  let multilineCommentEnded = true
  let inString: string | null = null
  let beforeChar: string | null = null

  while (index <= from) {
    const char = code[index]
    const sub = code[index] + code[index + 1]

    if (!inString) {
      if (sub === '/*') {
        multilineCommentStarted = true
        multilineCommentEnded = false
      }
      if (sub === '*/' && multilineCommentStarted) {
        multilineCommentStarted = false
        multilineCommentEnded = true
      }
      if (sub === '//') {
        commentStarted = true
        commentEnded = false
      }
      if ((char === '\n' || sub === '\r\n') && commentStarted) {
        commentStarted = false
        commentEnded = true
      }
    }

    if (!multilineCommentStarted && !commentStarted) {
      const isCharString = char === '"' || char === '\'' || char === '`'

      if (isCharString && beforeChar !== '\\') {
        if (inString === char)
          inString = null
        else if (!inString)
          inString = char
      }
    }

    beforeChar = code[index]
    index++
  }

  return {
    insideComment: !multilineCommentEnded || !commentEnded,
    insideString: inString !== null,
  }
}
