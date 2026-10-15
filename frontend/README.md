React: `AuthGate.tsx` muestra registro/login y recupera la sesión por cookie. `Shop.tsx` contiene catálogo, carrito, checkout, confirmación y mis pedidos. `AddressForm.tsx` permite guardar la dirección del comprador.

`npm run demo` desde la raíz prepara y sirve todo con una base local desechable. No persiste credenciales ni tokens en localStorage.

Para Vite, iniciar `APP_ORIGIN=http://127.0.0.1:5173 npm run demo` y ejecutar `npm run dev:ui` en otro terminal. La API queda en 3000 y el frontend en 5173. El Origin debe coincidir exactamente.

Ver [la guía](../README.md) para cookies, roles IAM y publicación bajo un mismo origen HTTPS con S3 y CloudFront.
