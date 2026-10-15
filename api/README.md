La API contiene once handlers en `src/functions/`. `auth.ts` atiende cuatro rutas: signup, login, logout y sesión. Las demás funciones son operaciones de la tienda.

Empezá por [la guía de arquitectura](../README.md), [auth.ts](src/functions/auth.ts) y [el guard de sesión](src/shared/http.ts). `local-api.ts` emula API Gateway localmente y no se empaqueta para AWS.
