/**
 * @typedef {Object} Route
 * @property {Object} methods
 * @property {string | string[]} path
 * @property {any[]} stack
 *
 * @typedef {Object} Endpoint
 * @property {string} path Path name
 * @property {string[]} methods Methods handled
 * @property {string[]} middlewares Mounted middlewares
 */

/**
 * @typedef {Object} Options
 * @property {boolean} includeMiddlewareRoutes Whether to include middleware routes in the results
 */

// Default global options
const DEFAULT_OPTIONS = {
  includeMiddlewareRoutes: true
}

const regExpToParseExpressPathRegExp = /^\/\^\\?\/?(?:(:?[\w\\.-]*(?:\\\/:?[\w\\.-]*)*)|(\(\?:\\?\/?\([^)]+\)\)))\\\/.*/
const regExpToReplaceExpressPathRegExpParams = /\(\?:\\?\/?\([^)]+\)\)/
const regexpExpressParamRegexp = /\(\?:\\?\\?\/?\([^)]+\)\)/g
const regexpExpressPathParamRegexp = /(:[^)]+)\([^)]+\)/g

const EXPRESS_ROOT_PATH_REGEXP_VALUE = '/^\\/?(?=\\/|$)/i'
const STACK_ITEM_VALID_NAMES = [
  'router',
  'bound dispatch',
  'mounted_app'
]

const STACK_ITEM_VALID_NAMES_INCLUDING_MIDDLEWARE_ROUTES = [
  '<anonymous>',
  ...STACK_ITEM_VALID_NAMES
]

/**
 * Returns all the verbs detected for the passed route
 * @param {Route} route
 */
const getRouteMethods = function (route) {
  let methods = Object.keys(route.methods)

  methods = methods.filter((method) => method !== '_all')
  methods = methods.map((method) => method.toUpperCase())

  return methods
}

/**
 * Returns the names (or anonymous) of all the middlewares attached to the
 * passed route
 * @param {Route} route
 * @returns {string[]}
 */
const getRouteMiddlewares = function (route) {
  return route.stack.map((item) => {
    return item.handle.name || 'anonymous'
  })
}

/**
 * Returns true if found regexp related with express params
 * @param {string} expressPathRegExp
 * @returns {boolean}
 */
const hasParams = function (expressPathRegExp) {
  return regexpExpressParamRegexp.test(expressPathRegExp)
}

/**
 * @param {Route} route Express route object to be parsed
 * @param {string} basePath The basePath the route is on
 * @return {Endpoint[]} Endpoints info
 */
const parseExpressRoute = function (route, basePath) {
  const paths = []

  if (Array.isArray(route.path)) {
    paths.push(...route.path)
  } else {
    paths.push(route.path)
  }

  /** @type {Endpoint[]} */
  const endpoints = paths.map((path) => {
    const completePath = basePath && path === '/'
      ? basePath
      : `${basePath}${path}`

    /** @type {Endpoint} */
    const endpoint = {
      path: completePath.replace(regexpExpressPathParamRegexp, '$1'),
      methods: getRouteMethods(route),
      middlewares: getRouteMiddlewares(route)
    }

    return endpoint
  })

  return endpoints
}

/**
 * @param {RegExp} expressPathRegExp
 * @param {any[]} params
 * @returns {string}
 */
const parseExpressPath = function (expressPathRegExp, params) {
  let parsedRegExp = expressPathRegExp.toString()
  let expressPathRegExpExec = regExpToParseExpressPathRegExp.exec(parsedRegExp)
  let paramIndex = 0

  while (hasParams(parsedRegExp)) {
    const paramName = params[paramIndex].name
    const paramId = `:${paramName}`

    parsedRegExp = parsedRegExp
      .replace(regExpToReplaceExpressPathRegExpParams, (str) => {
        // Express >= 4.20.0 uses a different RegExp for parameters: it
        // captures the slash as part of the parameter. We need to check
        // for this case and add the slash to the value that will replace
        // the parameter in the path.
        if (str.startsWith('(?:\\/')) {
          return `\\/${paramId}`
        }

        return paramId
      })

    paramIndex++
  }

  if (parsedRegExp !== expressPathRegExp.toString()) {
    expressPathRegExpExec = regExpToParseExpressPathRegExp.exec(parsedRegExp)
  }

  const parsedPath = expressPathRegExpExec[1].replace(/\\\//g, '/')

  return parsedPath
}

/**
 * @param {import('express').Express | import('express').Router | any} app
 * @param {string} [basePath]
 * @param {Endpoint[]} [endpoints]
 * @param {Options} [options]
 * @returns {Endpoint[]}
 */
const parseEndpoints = function (app, basePath, endpoints, options) {
  const stack = app.stack || (app._router && app._router.stack)

  endpoints = endpoints || []
  basePath = basePath || ''

  if (!stack) {
    if (endpoints.length) {
      endpoints = addEndpoints(endpoints, [{
        path: basePath,
        methods: [],
        middlewares: []
      }])
    }
  } else {
    endpoints = parseStack(stack, basePath, endpoints, options)
  }

  return endpoints
}

/**
 * Ensures the path of the new endpoints isn't yet in the array.
 * If the path is already in the array merges the endpoints with the existing
 * one, if not, it adds them to the array.
 *
 * @param {Endpoint[]} currentEndpoints Array of current endpoints
 * @param {Endpoint[]} endpointsToAdd New endpoints to be added to the array
 * @returns {Endpoint[]} Updated endpoints array
 */
const addEndpoints = function (currentEndpoints, endpointsToAdd) {
  endpointsToAdd.forEach((newEndpoint) => {
    const existingEndpoint = currentEndpoints.find(
      (endpoint) => endpoint.path === newEndpoint.path
    )

    if (existingEndpoint !== undefined) {
      const newMethods = newEndpoint.methods.filter(
        (method) => !existingEndpoint.methods.includes(method)
      )

      existingEndpoint.methods = existingEndpoint.methods.concat(newMethods)
    } else {
      currentEndpoints.push(newEndpoint)
    }
  })

  return currentEndpoints
}

/**
 * @param {any[]} stack
 * @param {string} basePath
 * @param {Endpoint[]} endpoints
 * @param {Options} [options]
 * @returns {Endpoint[]}
 */
const parseStack = function (stack, basePath, endpoints, options) {
  // Use provided options or fall back to global options
  const VALID_NAMES = options.includeMiddlewareRoutes ? STACK_ITEM_VALID_NAMES_INCLUDING_MIDDLEWARE_ROUTES : STACK_ITEM_VALID_NAMES
  stack.forEach((stackItem) => {
    if (stackItem.route) {
      const newEndpoints = parseExpressRoute(stackItem.route, basePath)

      endpoints = addEndpoints(endpoints, newEndpoints)
    } else if (VALID_NAMES.includes(stackItem.name)) {
      const isExpressPathRegexp = regExpToParseExpressPathRegExp.test(stackItem.regexp)

      let newBasePath = basePath

      if (isExpressPathRegexp) {
        const parsedPath = parseExpressPath(stackItem.regexp, stackItem.keys)

        newBasePath += `/${parsedPath}`
      } else if (!stackItem.path && stackItem.regexp && stackItem.regexp.toString() !== EXPRESS_ROOT_PATH_REGEXP_VALUE) {
        const regExpPath = ` RegExp(${stackItem.regexp}) `

        newBasePath += `/${regExpPath}`
      }

      endpoints = parseEndpoints(stackItem.handle, newBasePath, endpoints, options)
    }
  })

  return endpoints
}

/**
 * Returns an array of strings with all the detected endpoints
 * @param {import('express').Express | import('express').Router | any} app The express/router instance to get the endpoints from
 * @param {Options} [options] Optional settings that override global options
 * @returns {Endpoint[]}
 */
const expressListEndpoints = function (app, options) {
  // Merge provided options with global options
  const mergedOptions = { ...DEFAULT_OPTIONS, ...(options || {}) }
  const endpoints = parseEndpoints(app, '', [], mergedOptions)

  return endpoints
}

module.exports = expressListEndpoints
