import { Express, Router as originalRouter } from 'express';
import { OperationContract, Resource } from '@azure/arm-apimanagement/esm/models';
import { Location, Endpoint as EndpointEntity } from './endpoint';
import { RequestHandler } from 'express-serve-static-core';
import { Logger } from './logger';

/**
 * Converts Express app or router to APIM
 */
export class ExpressToAPIM {
  // I never liked using regex, but now I'm really hating it.
  private paramRegex = /\(\?\:(\\\/|)\(.*?\)\)\??/gi;
  private removalRegex = /\/\^|\/i$|\\\/\?\$|\\\/\?\(\?\=\\\/\|\$\)/gi;
  private slashRegex = /\\\//gi;

  private operationIdCount = 0;
  private endpoints: Endpoints = {};

  /**
   * Create ExpressToAPIM instance
   * @param logger - a logger
   * @param express - express app or router
   * @param basePath - base path for the endpoints
   */
  constructor(private logger: Logger, private express: Express | Router, private basePath: string = '') {}

  /**
   * Execute express lookup and return endpoints
   * @param breakOnSamePath - should it throw an error if there is
   *                          same path more than once.
   */
  public exec(breakOnSamePath: boolean) {
    // Clear endpoints
    this.endpoints = {};

    this.logger.info('Looking for routes');
    this.loopLayers(this.express, this.basePath);
    this.locateSamePath(breakOnSamePath);

    return this.endpoints;
  }

  /**
   * Looks if there is a repeating path
   * @param breakOnSamePath - should throw error if a same path found?
   */
  private locateSamePath(breakOnSamePath: boolean) {
    this.logger.info('Looking for pathes overlap');

    const pathes: { [path: string]: { [method in Methods]?: boolean } } = {};
    let foundSamePath = false;

    Object.entries(this.endpoints).forEach(([path, methodObj]) =>
      Object.keys(methodObj).forEach(method => {
        const kindaParamlessPath = path.replace(/\{.*?\}/g, '{param}');

        if (!pathes[kindaParamlessPath]) pathes[kindaParamlessPath] = { [method]: false };
        else if (pathes[kindaParamlessPath][method] === undefined) pathes[kindaParamlessPath][method] = false;
        else if (pathes[kindaParamlessPath][method] === false) {
          foundSamePath = true;
          pathes[kindaParamlessPath][method] = true;
          this.logger.warn(
            `There is more than one path with the syntax of ${kindaParamlessPath} and the method of ${method}`
          );
        }
      })
    );

    if (foundSamePath && breakOnSamePath) throw new Error('Found more than one path with the same syntax');
  }

  /**
   * Loop in layers, look for routes and endpoints' middleware, and
   * populate the endpoints object
   * @param express - express app or router
   * @param basePath - base path for the endpoints
   * @param endpoints - endpoints list of metadata and policies
   */
  private loopLayers(express: Express | Router | Route, basePath: string = '', endpoints: EndpointEntity[] = []) {
    const stack: Layer[] = '_router' in express ? express._router.stack : express.stack;

    stack.forEach(layer => {
      // If layer is an APIMify middleware, add it to the endpoints list of metadata and policies
      if (layer.name === 'APIMEndpoint') {
        const endpoint = EndpointEntity.find(layer.handle as RequestHandler);
        // Recreate to prevent error due to arrays being passed by reference
        if (endpoint) endpoints = [...endpoints, endpoint];
        return;
      }

      // If layer is a route, add it as an endpoint. Pass endpoints
      // by value (kinda).
      if (layer.route && this.isRoute(layer.route, basePath, [...endpoints])) return;

      const path = this.getPath(layer);

      // If has route, follow it's stack.
      if (layer.route && layer.route.stack && layer.route.stack.length)
        return this.loopLayers(layer.route, ExpressToAPIM.margePath(basePath, path), endpoints);

      // If handle is a Router, follow it's stack.
      if (layer.handle && 'stack' in layer.handle)
        return this.loopLayers(layer.handle, ExpressToAPIM.margePath(basePath, path), endpoints);
    });
  }

  /**
   * Returns path from a layer
   * @param layer - a layer
   */
  private getPath(layer: Layer) {
    if (layer.path) return ExpressToAPIM.trimSlash(layer.path);
    if (layer.regexp.fast_slash) return '';
    return ExpressToAPIM.trimSlash(this.decodeRegex(layer.regexp, layer.keys));
  }

  /**
   * Checks if it's a route. If it is, it'll add it to the endpoints
   * object and will return true, otherwise, false.
   * @param route - a route
   * @param basePath - the path to append to route's path
   * @param endpoints - endpoints list of metadata and policies
   */
  private isRoute(route: Route, basePath: string = '', endpoints: EndpointEntity[] = []) {
    if (!route.methods) return false;
    if (!route.stack || !route.stack.length) return false;

    let method: Methods;
    const path = ExpressToAPIM.margePath(basePath, route.path);

    const isRoute = route.stack.every(layer => {
      // If layer don't have a method, it's not a route.
      if (!layer.method) return false;
      // If layer's regex is not simple slash, it's not a route
      if (!layer.regexp) return false;
      // If layer don't have function, non router handles,
      // you guessed it, it's not a route!
      if (
        !layer.handle ||
        ('stack' in layer.handle && layer.handle.stack.some(subLayer => subLayer.name && subLayer.regexp))
      )
        return false;

      if (layer.name === 'APIMEndpoint') {
        const endpoint = EndpointEntity.find(layer.handle as RequestHandler);
        if (endpoint) endpoints.push(endpoint);
      }

      if (method !== layer.method) method = layer.method;

      return true;
    });

    if (isRoute) {
      this.addEndpoint(`/${path}`, method, EndpointEntity.margeEndpoints(endpoints));
      return true;
    }
    return false;
  }

  /**
   * Convert regex to path
   * @param regex - Regex to convert into path
   * @param params - path's params
   */
  private decodeRegex(regex: RegExp, params: Key[]) {
    params = params.sort((a, b) => a.offset - b.offset);
    const regexStr = regex.toString();
    let counter = 0;

    const path = regexStr
      .replace(this.paramRegex, (m, p1) => `${p1}:${params[counter++].name}`)
      .replace(this.removalRegex, '')
      .replace(this.slashRegex, '/');

    return path;
  }

  /**
   * Ensures the path of the new endpoint isn't yet in the object.
   * If the path is already in the object merges the endpoint with the existing
   * one, if not, it adds it to the object. It generates operationId and displayName.
   * @param path - Full path for the endpoint
   * @param method - HTTP verb
   * @param endpoint - endpoint information
   */
  private addEndpoint(path: string, method: Methods, endpoint?: Partial<EndpointWithPolicyObj>) {
    if (!this.endpoints[path]) this.endpoints[path] = {};
    method = method.toUpperCase() as Methods;

    const oldEndpoint = this.endpoints[path][method] || ({ policies: {} } as EndpointWithPolicyObj);

    const { urlTemplate, templateParameters } = this.getParams(path);
    const operationId = this.generateOperationId(path, method);
    const displayName = this.generateOperationName(path, method);
    const tags: EndpointWithPolicyObj['tags'] = [...(oldEndpoint.tags || []), ...(endpoint.tags || [])];
    const policies: EndpointWithPolicyObj['policies'] = {
      'inbound': [...(oldEndpoint.policies.inbound || []), ...(endpoint.policies.inbound || [])],
      'backend': [...(oldEndpoint.policies.backend || []), ...(endpoint.policies.backend || [])],
      'outbound': [...(oldEndpoint.policies.outbound || []), ...(endpoint.policies.outbound || [])],
      'on-error': [...(oldEndpoint.policies['on-error'] || []), ...(endpoint.policies['on-error'] || [])]
    };

    this.endpoints[path][method] = {
      operationId,
      displayName,
      method,
      urlTemplate,
      templateParameters,
      ...(oldEndpoint || {}),
      ...(endpoint || {}),
      policies,
      tags
    };

    this.logger.info(`Adding endpoint: ${method} ${path}`);
  }

  /**
   * Looks for params, changes it to match the way APIM stores params in URL
   * and generates templateParameters object
   * @param path - full path to look for params
   */
  private getParams(path: string) {
    const templateParameters: Endpoint['templateParameters'] = [];

    const urlTemplate = path
      .split('/')
      // What's going on?
      .map(subPath =>
        subPath
          .split('-')
          // Can it go even deeper?
          .map(subSubPath =>
            subSubPath
              .split('.')
              // You bet it can!
              .map(pathPart => {
                // if has regex or starts with :
                // I'll consider it as a param
                const regexToCheckIfRegex = /[\:\?\+\*\(\)\|]/g;
                if (regexToCheckIfRegex.test(pathPart)) {
                  // Remove all regexy stuff.
                  pathPart = pathPart.replace(regexToCheckIfRegex, '');

                  // If param name is 2 or less chars, or if param with same name
                  // exists, add one more digit.
                  if (pathPart.length <= 2 || templateParameters.find(param => param.name === pathPart))
                    pathPart = `${pathPart}P${++this.operationIdCount}`;

                  templateParameters.push({
                    name: pathPart,
                    required: true,
                    type: 'string'
                  });

                  // Convert to APIM path param
                  pathPart = `{${pathPart}}`;
                }
                return pathPart;
              })
              .join('.')
          )
          .join('-')
      )
      .join('/');

    return { urlTemplate, templateParameters };
  }

  /**
   * Generates unique operation ID
   * @param path - Operation path
   * @param method - Operation method
   */
  private generateOperationId(path: string, method: Methods) {
    path = ExpressToAPIM.trimSlash(path)
      .trim()
      .toLowerCase()
      .replace(/\//g, '-')
      .replace(/[^A-z0-9\-]/g, '')
      .substr(0, 30);

    return `apimify-${ExpressToAPIM.trimMinus(path)}-${method}-${++this.operationIdCount}`;
  }

  /**
   * Generates semi-understandable name for the operation
   * @param path - Operation path
   * @param method - Operation method
   */
  private generateOperationName(path: string, method: Methods) {
    path = ExpressToAPIM.trimSlash(path)
      .replace(/\/|\-/g, ' ')
      .replace(/[^A-z0-9\ ]/g, '')
      .split(' ')
      .map(t => t && this.capitalize(t))
      .join(' ');
    method = this.capitalize(method) as Methods;

    return `${method} ${path.substr(0, 30)}`;
  }

  /**
   * Capitalizes first letter
   * @param str - string to capitalize
   */
  private capitalize(str: string) {
    const [c, ...e] = str;
    return `${c.toUpperCase()}${e.join('').toLowerCase()}`;
  }

  /**
   * marges paths
   * @param paths - a path to marge
   */
  public static margePath(...paths: string[]) {
    return paths
      .map(path => ExpressToAPIM.trimSlash(path))
      .filter(path => !!path.length)
      .join('/');
  }

  /**
   * Remove leading and trialing slash
   * @param str - string to trim slashes
   */
  public static trimSlash(str: string) {
    return str.trim().replace(/\/$|^\//g, '');
  }

  /**
   * Remove leading and trialing minus
   * @param str - string to trim minuses
   */
  private static trimMinus(str: string) {
    return str.trim().replace(/\-$|^\-/g, '');
  }
}

type Methods = 'get' | 'post' | 'put' | 'delete' | 'patch' | 'options' | 'head';

interface Key {
  name: string;
  optional: boolean;
  offset: number;
}

interface Route {
  path: string;
  stack: Layer[];
  methods: { [key in Methods]?: boolean };
}

interface Router extends originalRouter {
  stack: Layer[];
}

interface Layer {
  handle: Function | Router;
  name: 'expressInit' | 'query' | 'bound dispatch' | 'router' | '<anonymous>' | 'APIMEndpoint';
  params?: any[];
  path?: string;
  keys: Key[];
  regexp: RegExp & { fast_star: boolean; fast_slash: boolean };
  route?: Route;
  method?: Methods;
}

interface Endpoint extends Omit<OperationContract, keyof Resource> {
  /** Operation identifier within an API. Must be unique in the current API Management service instance. */
  operationId: string;
}

export interface EndpointWithPolicyObj extends Omit<Endpoint, 'policies'> {
  /** Operation Policies */
  policies: {
    [key in Location]?: string[];
  };
  /** List of tags */
  tags?: string[];
}

export interface Endpoints {
  [path: string]: {
    [method in Methods]?: EndpointWithPolicyObj;
  };
}
