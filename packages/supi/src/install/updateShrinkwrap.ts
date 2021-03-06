import logger from '@pnpm/logger'
import { Resolution } from '@pnpm/resolver-base'
import { Dependencies } from '@pnpm/types'
import * as dp from 'dependency-path'
import getNpmTarballUrl from 'get-npm-tarball-url'
import {
  DependencyShrinkwrap,
  PackageSnapshot,
  pruneSharedShrinkwrap,
  ResolvedDependencies,
  Shrinkwrap,
  ShrinkwrapResolution,
} from 'pnpm-shrinkwrap'
import R = require('ramda')
import { absolutePathToRef } from './shrinkwrap'
import { DependenciesGraph } from './resolvePeers'

export default function (
  depGraph: DependenciesGraph,
  shrinkwrap: Shrinkwrap,
  prefix: string,
  defaultRegistry: string,
): {
  newShrinkwrap: Shrinkwrap,
  pendingRequiresBuilds: PendingRequiresBuild[],
} {
  shrinkwrap.packages = shrinkwrap.packages || {}
  const pendingRequiresBuilds = [] as PendingRequiresBuild[]
  for (const depPath of R.keys(depGraph)) {
    const relDepPath = dp.relative(defaultRegistry, depPath)
    const result = R.partition(
      (child) => depGraph[depPath].optionalDependencies.has(depGraph[child.depPath].name),
      R.keys(depGraph[depPath].children).map((alias) => ({ alias, depPath: depGraph[depPath].children[alias] })),
    )
    shrinkwrap.packages[relDepPath] = toShrDependency(pendingRequiresBuilds, depGraph[depPath].additionalInfo, {
      depGraph,
      depPath,
      prevSnapshot: shrinkwrap.packages[relDepPath],
      registry: defaultRegistry,
      relDepPath,
      updatedDeps: result[1],
      updatedOptionalDeps: result[0],
    })
  }
  const warn = (message: string) => logger.warn({ message, prefix })
  return {
    newShrinkwrap: pruneSharedShrinkwrap(shrinkwrap, { defaultRegistry, warn }),
    pendingRequiresBuilds,
  }
}

export interface PendingRequiresBuild {
  relativeDepPath: string,
  absoluteDepPath: string,
}

function toShrDependency (
  pendingRequiresBuilds: PendingRequiresBuild[],
  pkg: {
    deprecated?: string,
    peerDependencies?: Dependencies,
    bundleDependencies?: string[],
    bundledDependencies?: string[],
    engines?: {
      node?: string,
      npm?: string,
    },
    cpu?: string[],
    os?: string[],
  },
  opts: {
    depPath: string,
    relDepPath: string,
    registry: string,
    updatedDeps: Array<{alias: string, depPath: string}>,
    updatedOptionalDeps: Array<{alias: string, depPath: string}>,
    depGraph: DependenciesGraph,
    prevSnapshot?: PackageSnapshot,
  },
): DependencyShrinkwrap {
  const depNode = opts.depGraph[opts.depPath]
  const shrResolution = toShrResolution(
    { name: depNode.name, version: depNode.version },
    opts.relDepPath,
    depNode.resolution,
    opts.registry,
  )
  const newResolvedDeps = updateResolvedDeps(
    opts.prevSnapshot && opts.prevSnapshot.dependencies || {},
    opts.updatedDeps,
    opts.registry,
    opts.depGraph,
  )
  const newResolvedOptionalDeps = updateResolvedDeps(
    opts.prevSnapshot && opts.prevSnapshot.optionalDependencies || {},
    opts.updatedOptionalDeps,
    opts.registry,
    opts.depGraph,
  )
  const result = {
    resolution: shrResolution,
  }
  // tslint:disable:no-string-literal
  if (dp.isAbsolute(opts.relDepPath)) {
    result['name'] = depNode.name

    // There is no guarantee that a non-npmjs.org-hosted package
    // is going to have a version field
    if (depNode.version) {
      result['version'] = depNode.version
    }
  }
  if (!R.isEmpty(newResolvedDeps)) {
    result['dependencies'] = newResolvedDeps
  }
  if (!R.isEmpty(newResolvedOptionalDeps)) {
    result['optionalDependencies'] = newResolvedOptionalDeps
  }
  if (depNode.dev && !depNode.prod) {
    result['dev'] = true
  } else if (depNode.prod && !depNode.dev) {
    result['dev'] = false
  }
  if (depNode.optional) {
    result['optional'] = true
  }
  if (opts.depPath !== depNode.id) {
    result['id'] = depNode.id
  }
  if (pkg.peerDependencies) {
    result['peerDependencies'] = pkg.peerDependencies
  }
  if (pkg.engines) {
    for (const engine of R.keys(pkg.engines)) {
      if (pkg.engines[engine] === '*') continue
      result['engines'] = result['engines'] || {}
      result['engines'][engine] = pkg.engines[engine]
    }
  }
  if (pkg.cpu) {
    result['cpu'] = pkg.cpu
  }
  if (pkg.os) {
    result['os'] = pkg.os
  }
  if (pkg.bundledDependencies || pkg.bundleDependencies) {
    result['bundledDependencies'] = pkg.bundledDependencies || pkg.bundleDependencies
  }
  if (pkg.deprecated) {
    result['deprecated'] = pkg.deprecated
  }
  if (depNode.hasBin) {
    result['hasBin'] = true
  }
  if (opts.prevSnapshot) {
    if (opts.prevSnapshot.requiresBuild) {
      result['requiresBuild'] = opts.prevSnapshot.requiresBuild
    }
    if (opts.prevSnapshot.prepare) {
      result['prepare'] = opts.prevSnapshot.prepare
    }
  } else if (depNode.prepare) {
    result['prepare'] = true
    result['requiresBuild'] = true
  } else if (depNode.requiresBuild !== undefined) {
    if (depNode.requiresBuild) {
      result['requiresBuild'] = true
    }
  } else {
    pendingRequiresBuilds.push({
      absoluteDepPath: opts.depPath,
      relativeDepPath: opts.relDepPath,
    })
  }
  depNode.requiresBuild = result['requiresBuild']
  // tslint:enable:no-string-literal
  return result
}

// previous resolutions should not be removed from shrinkwrap
// as installation might not reanalize the whole dependency graph
// the `depth` property defines how deep should dependencies be checked
function updateResolvedDeps (
  prevResolvedDeps: ResolvedDependencies,
  updatedDeps: Array<{alias: string, depPath: string}>,
  registry: string,
  depGraph: DependenciesGraph,
) {
  const newResolvedDeps = R.fromPairs<string>(
    updatedDeps
      .map((dep): R.KeyValuePair<string, string> => {
        const depNode = depGraph[dep.depPath]
        return [
          dep.alias,
          absolutePathToRef(depNode.absolutePath, {
            alias: dep.alias,
            realName: depNode.name,
            resolution: depNode.resolution,
            standardRegistry: registry,
          }),
        ]
      }),
  )
  return R.merge(
    prevResolvedDeps,
    newResolvedDeps,
  )
}

function toShrResolution (
  pkg: {
    name: string,
    version: string,
  },
  relDepPath: string,
  resolution: Resolution,
  registry: string,
): ShrinkwrapResolution {
  // tslint:disable:no-string-literal
  if (dp.isAbsolute(relDepPath) || resolution.type !== undefined || !resolution['integrity']) {
    return resolution as ShrinkwrapResolution
  }
  const base = registry !== resolution['registry'] ? { registry: resolution['registry'] } : {}
  // Sometimes packages are hosted under non-standard tarball URLs.
  // For instance, when they are hosted on npm Enterprise. See https://github.com/pnpm/pnpm/issues/867
  // Or in othere weird cases, like https://github.com/pnpm/pnpm/issues/1072
  const expectedTarball = getNpmTarballUrl(pkg.name, pkg.version, { registry })
  const actualTarball = resolution['tarball'].replace('%2f', '/')
  if (removeProtocol(expectedTarball) !== removeProtocol(actualTarball)) {
    return {
      ...base,
      integrity: resolution['integrity'],
      tarball: relativeTarball(resolution['tarball'], registry),
    }
  }
  return {
    ...base,
    integrity: resolution['integrity'],
  }
  // tslint:enable:no-string-literal
}

function removeProtocol (url: string) {
  return url.split('://')[1]
}

function relativeTarball (tarball: string, registry: string) {
  if (tarball.substr(0, registry.length) === registry) {
    return tarball.substr(registry.length - 1)
  }
  return tarball
}
