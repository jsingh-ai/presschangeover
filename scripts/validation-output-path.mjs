import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const validationRoot = resolve(projectRoot, 'artifacts', 'validation')

export function resolveValidationOutputPath(outputPath) {
  const resolvedPath = resolve(outputPath)
  const relativePath = relative(validationRoot, resolvedPath)
  if (relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath))) {
    return resolvedPath
  }
  throw new Error(`Validation output must remain under ${validationRoot}`)
}
