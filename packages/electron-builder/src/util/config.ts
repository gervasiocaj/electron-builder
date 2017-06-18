import Ajv from "ajv"
import { CancellationToken } from "electron-builder-http"
import { debug } from "electron-builder-util"
import { deepAssign } from "electron-builder-util/out/deepAssign"
import { statOrNull } from "electron-builder-util/out/fs"
import { log, warn } from "electron-builder-util/out/log"
import { httpExecutor } from "electron-builder-util/out/nodeHttpExecutor"
import { orNullIfFileNotExist } from "electron-builder-util/out/promise"
import { readFile, readJson } from "fs-extra-p"
import { safeLoad } from "js-yaml"
import JSON5 from "json5"
import * as path from "path"
import { Config } from "../metadata"
import { reactCra } from "../presets/rectCra"
import AdditionalPropertiesParams = ajv.AdditionalPropertiesParams
import ErrorObject = ajv.ErrorObject
import TypeParams = ajv.TypeParams

function getConfigFromPackageData(metadata: any) {
  return metadata.build
}

/** @internal */
export async function doLoadConfig(configFile: string, projectDir: string): Promise<Config> {
  const data = await readFile(configFile, "utf8")
  let result
  if (configFile.endsWith(".json5") || configFile.endsWith(".json")) {
    result = JSON5.parse(data)
  }
  else if (configFile.endsWith(".toml")) {
    result = require("toml").parse(data)
  }
  else {
    result = safeLoad(data)
  }

  const relativePath = path.relative(projectDir, configFile)
  log(`Using ${relativePath.startsWith("..") ? configFile : relativePath} configuration file`)
  return result
}

/** @internal */
export async function loadConfig(projectDir: string, packageMetadata?: any): Promise<Config | null> {
  for (const configFile of ["electron-builder.yml", "electron-builder.yaml", "electron-builder.json", "electron-builder.json5", "electron-builder.toml"]) {
    const data = await orNullIfFileNotExist(doLoadConfig(path.join(projectDir, configFile), projectDir))
    if (data != null) {
      return data
    }
  }

  const data = getConfigFromPackageData(packageMetadata || (await orNullIfFileNotExist(readJson(path.join(projectDir, "package.json")))))
  if (data != null) {
    return data
  }

  if ((await statOrNull(path.join(projectDir, "app.asar"))) != null) {
    // prepacked, do not throw error, just ignore
    return null
  }

  throw new Error(`Cannot find package.json in the ${projectDir}`)
}

/** @internal */
export async function computeFinalConfig(projectDir: string, configPath: string | null, packageMetadata: any | null, configFromOptions: Config | null | undefined): Promise<Config> {
  let fileOrPackageConfig
  if (configPath == null) {
    fileOrPackageConfig = packageMetadata == null ? null : await loadConfig(projectDir, packageMetadata)
  }
  else {
    fileOrPackageConfig = await doLoadConfig(path.resolve(projectDir, configPath), projectDir)
  }

  let config = deepAssign(fileOrPackageConfig == null ? Object.create(null) : fileOrPackageConfig, configFromOptions)

  if (config.extends == null && config.extends !== null && packageMetadata != null) {
    const devDependencies = packageMetadata.devDependencies
    if (devDependencies != null && "react-scripts" in devDependencies) {
      (<any>config).extends = "react-cra"
    }
  }

  if (config.extends === "react-cra") {
    return deepAssign(await reactCra(projectDir), config)
  }
  else {
    return config
  }
}

/** @internal */
export async function getElectronVersion(config: Config | null | undefined, projectDir: string, projectMetadata?: any | null): Promise<string> {
  // build is required, but this check is performed later, so, we should check for null
  if (config != null && config.electronVersion != null) {
    return config.electronVersion
  }

  // projectMetadata passed only for prepacked app asar and in this case no dev deps in the app.asar
  if (projectMetadata == null) {
    for (const name of ["electron", "electron-prebuilt", "electron-prebuilt-compile"]) {
      try {
        return (await readJson(path.join(projectDir, "node_modules", name, "package.json"))).version
      }
      catch (e) {
        if (e.code !== "ENOENT") {
          warn(`Cannot read electron version from ${name} package.json: ${e.message}`)
        }
      }
    }
  }

  const packageJsonPath = path.join(projectDir, "package.json")
  const electronPrebuiltDep = findFromElectronPrebuilt(projectMetadata || await readJson(packageJsonPath))
  if (electronPrebuiltDep == null) {
    try {
      const releaseInfo = await httpExecutor.request<any>({
        hostname: "github.com",
        path: "/electron/electron/releases/latest",
        headers: {
          Accept: "application/json",
        },
      }, new CancellationToken())
      return (releaseInfo.tag_name.startsWith("v")) ? releaseInfo.tag_name.substring(1) : releaseInfo.tag_name
    }
    catch (e) {
      warn(e)
    }

    throw new Error(`Cannot find electron dependency to get electron version in the '${packageJsonPath}'`)
  }

  const firstChar = electronPrebuiltDep[0]
  return firstChar === "^" || firstChar === "~" ? electronPrebuiltDep.substring(1) : electronPrebuiltDep
}

function findFromElectronPrebuilt(packageData: any): any {
  for (const name of ["electron", "electron-prebuilt", "electron-prebuilt-compile"]) {
    const devDependencies = packageData.devDependencies
    let dep = devDependencies == null ? null : devDependencies[name]
    if (dep == null) {
      const dependencies = packageData.dependencies
      dep = dependencies == null ? null : dependencies[name]
    }
    if (dep != null) {
      return dep
    }
  }
  return null
}

let validatorPromise: Promise<any> | null = null

async function createConfigValidator() {
  const ajv = new Ajv({allErrors: true})
  ajv.addMetaSchema(require("ajv/lib/refs/json-schema-draft-04.json"))
  require("ajv-keywords")(ajv, ["typeof"])
  const schema = await readJson(path.join(__dirname, "..", "..", "scheme.json"))
  return ajv.compile(schema)
}

/** @internal */
export async function validateConfig(config: Config) {
  const extraMetadata = config.extraMetadata
  if (extraMetadata != null) {
    if (extraMetadata.build != null) {
      throw new Error(`--em.build is deprecated, please specify as -c"`)
    }
    if (extraMetadata.directories != null) {
      throw new Error(`--em.directories is deprecated, please specify as -c.directories"`)
    }
  }

  if (validatorPromise == null) {
    validatorPromise = createConfigValidator()
  }

  const validator = await validatorPromise
  if (!validator(config)) {
    debug(JSON.stringify(validator.errors, null, 2))
    throw new Error(`Config is invalid:
${JSON.stringify(normaliseErrorMessages(validator.errors!), null, 2)}

How to fix:
  1. Open https://github.com/electron-userland/electron-builder/wiki/Options
  2. Search the option name on the page.
    * Not found? The option was deprecated or not exists (check spelling).
    * Found? Check that the option in the appropriate place. e.g. "title" only in the "dmg", not in the root.
`)
  }
}

function normaliseErrorMessages(errors: Array<ErrorObject>) {
  const result: any = Object.create(null)
  for (const e of errors) {
    if (e.keyword === "type" && (<TypeParams>e.params).type === "null") {
      // ignore - no sense to report that type accepts null
      continue
    }

    const dataPath = e.dataPath.length === 0 ? [] : e.dataPath.substring(1).split(".")
    if (e.keyword === "additionalProperties") {
      dataPath.push((<AdditionalPropertiesParams>e.params).additionalProperty)
    }

    let o = result
    let lastName: string | null = null
    for (const p of dataPath) {
      if (p === dataPath[dataPath.length - 1]) {
        lastName = p
        break
      }
      else {
        if (o[p] == null) {
          o[p] = Object.create(null)
        }
        else if (typeof o[p] === "string") {
          o[p] = [o[p]]
        }
        o = o[p]
      }
    }

    if (lastName == null) {
      lastName = "unknown"
    }

    let message = e.message!.toUpperCase()[0] + e.message!.substring(1)
    switch (e.keyword) {
      case "additionalProperties":
        message = "Unknown option"
        break

      case "required":
        message = "Required option"
        break

      case "anyOf":
        message = "Invalid option object"
        break
    }

    if (o[lastName] != null && !Array.isArray(o[lastName])) {
      o[lastName] = [o[lastName]]
    }

    if (Array.isArray(o[lastName])) {
      o[lastName].push(message)
    }
    else {
      o[lastName] = message
    }
  }
  return result
}