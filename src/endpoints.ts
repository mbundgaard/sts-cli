export type Addressing = 'path' | 'query' | 'header';
export interface Endpoint {
  noun: string; verb: string; description: string; path: string; addressing: Addressing;
  location?: boolean; rvc?: boolean; employeeId?: boolean; paged?: boolean;
}
export const endpoints: Endpoint[] = [
  { noun: 'location', verb: 'list', description: 'List organization locations', path: '/api/v1/organizations/{org}/locations', addressing: 'path', paged: true },
  { noun: 'location', verb: 'get', description: 'Get a location', path: '/api/v1/organizations/{org}/locations/{loc}', addressing: 'path', location: true },
  { noun: 'rvc', verb: 'list', description: 'List revenue centers and order types', path: '/api/v1/organizations/{org}/locations/{loc}/revenueCenters', addressing: 'path', location: true, paged: true },
  { noun: 'rvc', verb: 'get', description: 'Get a revenue center', path: '/api/v1/organizations/{org}/locations/{loc}/revenueCenters/{rvc}', addressing: 'path', location: true, rvc: true },
  { noun: 'org', verb: 'list', description: 'List accessible organizations', path: '/api/v1/organizations', addressing: 'path' },
  { noun: 'org', verb: 'get', description: 'Get the configured organization', path: '/api/v1/organizations/{org}', addressing: 'path' },
  ...[
    ['tender', '/api/v1/tenders/collection', 'List payment and service-total tenders'],
    ['tax', '/api/v1/taxes', 'List taxes'],
    ['service-charge', '/api/v1/serviceCharges/collection', 'List service charges'],
    ['discount', '/api/v1/discounts/collection', 'List discounts'],
    ['barcode', '/api/v1/barcodes/collection', 'List barcodes'],
    ['menu', '/api/v1/menus/summary', 'List menu summaries'],
  ].map(([noun, path, description]) => ({ noun: noun!, verb: 'list', path: path!, description: description!, addressing: 'query' as const, location: true, rvc: true })),
  { noun: 'menu', verb: 'get', description: 'Get full v2 menu; default ID is <org>:<loc>:<rvc>', path: '/api/v2/menus/{menuId}', addressing: 'header', location: true, rvc: true },
  { noun: 'menu', verb: 'unavailable', description: 'List unavailable menu items', path: '/api/v1/menus/items/unavailable', addressing: 'query', location: true, rvc: true },
  { noun: 'employee', verb: 'get', description: 'Resolve employee by EmployeeId', path: '/api/v1/employees', addressing: 'query', location: true, employeeId: true },
];
