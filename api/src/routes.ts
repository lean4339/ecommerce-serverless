// Este mapa se usa SOLO en el emulador local y las pruebas. En AWS enruta API Gateway.
export const routes = [
  { name: 'auth', method: 'POST', path: '/api/v1/auth/signup' },
  { name: 'auth', method: 'POST', path: '/api/v1/auth/login' },
  { name: 'auth', method: 'POST', path: '/api/v1/auth/logout' },
  { name: 'auth', method: 'GET', path: '/api/v1/auth/session' },
  { name: 'list-products', method: 'GET', path: '/api/v1/store/products' },
  { name: 'get-product', method: 'GET', path: '/api/v1/store/products/{id}' },
  { name: 'get-filters', method: 'GET', path: '/api/v1/store/filters' },
  { name: 'get-customer', method: 'GET', path: '/api/v1/store/customer' },
  { name: 'create-address', method: 'POST', path: '/api/v1/store/customer/addresses' },
  { name: 'get-cart', method: 'GET', path: '/api/v1/cart' },
  { name: 'update-cart', method: 'PUT', path: '/api/v1/cart' },
  { name: 'create-order', method: 'POST', path: '/api/v1/orders' },
  { name: 'list-orders', method: 'GET', path: '/api/v1/orders' },
  { name: 'get-order', method: 'GET', path: '/api/v1/orders/{id}' },
] as const;

export const functionNames = [...new Set(routes.map((route) => route.name))];
