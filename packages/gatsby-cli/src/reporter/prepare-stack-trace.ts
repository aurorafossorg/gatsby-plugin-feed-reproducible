/* Code borrowed and based on
 * https://github.com/evanw/node-source-map-support/blob/master/source-map-support.js
 */

import { readFileSync, readdirSync } from "fs"
import { codeFrameColumns } from "@babel/code-frame"
import stackTrace from "stack-trace"
import {
  SourceMapConsumer,
  BasicSourceMapConsumer,
  IndexedSourceMapConsumer,
  NullableMappedPosition,
} from "source-map"
import * as path from "path"

export class ErrorWithCodeFrame extends Error {
  codeFrame?: string = ``

  constructor(error: Error) {
    super(error.message)

    // We must use getOwnProperty because keys like `stack` are not enumerable,
    // but we want to copy over the entire error
    Object.getOwnPropertyNames(error).forEach(key => {
      this[key] = error[key]
    })
  }
}

export async function prepareStackTrace(
  error: Error,
  sourceOfMainMap: string
): Promise<ErrorWithCodeFrame> {
  const newError = new ErrorWithCodeFrame(error)
  // source point to single map, but with code splitting for build-html we need to handle more maps
  // we use fact that all .map files will be in same dir as main one here
  const bundleDir = path.dirname(sourceOfMainMap)
  const bundleDirMapFiles = readdirSync(bundleDir)
    .filter(fileName => fileName.endsWith(`.js.map`))
    .map(fileName => path.join(bundleDir, fileName))

  const maps = await Promise.all(
    bundleDirMapFiles.map(
      async source => await new SourceMapConsumer(readFileSync(source, `utf8`))
    )
  )

  const stack = stackTrace
    .parse(newError)
    .map(frame => wrapCallSite(maps, frame))
    .filter(
      frame =>
        `wasConverted` in frame &&
        (!frame.getFileName() ||
          !frame
            .getFileName()
            .match(/^webpack:\/+(lib\/)?(webpack\/|\.cache\/)/))
    )

  newError.codeFrame = getErrorSource(maps, stack[0])
  newError.stack =
    `${newError.name}: ${newError.message}\n` +
    stack.map(frame => `    at ${frame}`).join(`\n`)

  return newError
}

function getErrorSource(
  maps: Array<BasicSourceMapConsumer | IndexedSourceMapConsumer>,
  topFrame: stackTrace.StackFrame | IWrappedStackFrame
): string {
  let source
  for (const map of maps) {
    source = map.sourceContentFor(topFrame.getFileName(), true)
    if (source) {
      break
    }
  }

  return source
    ? codeFrameColumns(
        source,
        {
          start: {
            line: topFrame.getLineNumber(),
            column: topFrame.getColumnNumber(),
          },
        },
        {
          highlightCode: true,
        }
      )
    : ``
}

interface IWrappedStackFrame {
  getFileName(): string
  getLineNumber(): number
  getColumnNumber(): number
  getScriptNameOrSourceURL(): string
  toString: typeof CallSiteToString
  wasConverted: true
}

function wrapCallSite(
  maps: Array<BasicSourceMapConsumer | IndexedSourceMapConsumer>,
  frame: stackTrace.StackFrame
): IWrappedStackFrame | stackTrace.StackFrame {
  const source = frame.getFileName()
  if (!source) return frame

  const position = getPosition({ maps, frame })
  if (!position.source) return frame

  return {
    getFileName: (): string => position.source || ``,
    getLineNumber: (): number => position.line || 0,
    getColumnNumber: (): number => (position.column || 0) + 1,
    getScriptNameOrSourceURL: (): string => position.source || ``,
    toString: CallSiteToString,
    wasConverted: true,
  }
}

function getPosition({
  maps,
  frame,
}: {
  maps: Array<BasicSourceMapConsumer | IndexedSourceMapConsumer>
  frame: stackTrace.StackFrame
}): NullableMappedPosition {
  if (frame.getFileName().includes(`webpack:`)) {
    // if source-map-register is initiated, stack traces would already be converted
    return {
      column: frame.getColumnNumber() - 1,
      line: frame.getLineNumber(),
      source: frame
        .getFileName()
        .slice(frame.getFileName().indexOf(`webpack:`))
        .replace(/webpack:\/+/g, `webpack://`),
      name: null,
    }
  }

  const line = frame.getLineNumber()
  const column = frame.getColumnNumber()
  for (const map of maps) {
    const test = map.originalPositionFor({ line, column })
    if (test.source) {
      return test
    }
  }

  return { source: null, column: null, line: null, name: null }
}

// This is copied almost verbatim from the V8 source code at
// https://code.google.com/p/v8/source/browse/trunk/src/messages.js.
function CallSiteToString(): string {
  // @ts-ignore
  const _this = this // eslint-disable-line @typescript-eslint/no-this-alias
  const self = _this as
    | NodeJS.CallSite
    | IWrappedStackFrame
    | stackTrace.StackFrame

  let fileName
  let fileLocation = ``
  if (`isNative` in self && self.isNative()) {
    fileLocation = `native`
  } else {
    fileName =
      (`getScriptNameOrSourceURL` in self && self.getScriptNameOrSourceURL()) ||
      (`getFileName` in self && self.getFileName())

    if (!fileName && `isEval` in self && self.isEval()) {
      fileLocation = `${self.getEvalOrigin()}, `
    }

    if (fileName) {
      fileLocation += fileName.replace(/^webpack:\/+(lib\/)?/, ``)
    } else {
      // Source code does not originate from a file and is not native, but we
      // can still get the source position inside the source string, e.g. in
      // an eval string.
      fileLocation += `<anonymous>`
    }
    const lineNumber = `getLineNumber` in self ? self.getLineNumber() : null
    if (lineNumber != null) {
      fileLocation += `:${lineNumber}`
      const columnNumber =
        `getColumnNumber` in self ? self.getColumnNumber() : null
      if (columnNumber) {
        fileLocation += `:${columnNumber}`
      }
    }
  }

  let line = ``
  const functionName = `getFunctionName` in self ? self.getFunctionName() : ``
  let addSuffix = true
  const isConstructor = `isConstructor` in self && self.isConstructor()
  const methodName = `getMethodName` in self ? self.getMethodName() : ``
  const typeName = `getTypeName` in self ? self.getTypeName() : ``
  const isMethodCall =
    methodName &&
    !((`isToplevel` in self && self.isToplevel()) || isConstructor)
  if (isMethodCall && functionName) {
    if (typeName && functionName.indexOf(typeName) != 0) {
      line += `${typeName}.`
    }
    line += functionName
    if (
      functionName.indexOf(`.` + methodName) !=
      functionName.length - (methodName || ``).length - 1
    ) {
      line += ` [as ${methodName}]`
    }
  } else if (typeName && !functionName) {
    line += typeName + `.` + (methodName || `<anonymous>`)
  } else if (isConstructor) {
    line += `new ` + (functionName || `<anonymous>`)
  } else if (functionName) {
    line += functionName
  } else {
    line += fileLocation
    addSuffix = false
  }
  if (addSuffix) line += ` (${fileLocation})`
  return line
}
