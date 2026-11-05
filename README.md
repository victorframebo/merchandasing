# Tienda OIKOS

Catálogo con stock por talla, reservas de pedidos y panel del vendedor. Sin dependencias: solo Node 18 o más nuevo.

## Probar en local

```
ADMIN_PIN=1234 node server.js
```

- Tienda: http://localhost:3000
- Panel del vendedor: http://localhost:3000/#admin (entra con el PIN)

## Cómo funciona

- El cliente elige talla y pulsa **Reservar mi pedido**. El servidor aparta las unidades (todo o nada) y nadie más puede pedirlas.
- El pedido aparece en el panel con un código. El cliente lo envía por WhatsApp con ese código.
- **Confirmar venta** descuenta la existencia. **Cancelar** libera las unidades. Una reserva sin confirmar vence sola (24 h por defecto, se cambia en Ajustes).
- Los clientes nunca ven cantidades, solo las tallas disponibles, "Agotado" o "A pedido".
- Límites contra abusos: 3 reservas pendientes por persona, 12 pedidos por hora, 10 unidades por talla en cada pedido.

## Archivos

- `server.js`: servidor y API.
- `core.js`: reglas de stock y reservas (las usan el servidor y la vista previa).
- `index.html`: tienda y panel.
- `catalogo.json`: catálogo inicial. Se copia a `data/store.json` la primera vez que arranca.
- `data/`: datos reales (pedidos, stock, fotos). Se crea solo y no va a Git. Haz copias de esta carpeta.

## Variables

| Variable | Para qué | Por defecto |
|---|---|---|
| `PORT` | puerto | 3000 |
| `ADMIN_PIN` | PIN del vendedor (también se cambia en Ajustes) | 1234 |
| `DATA_DIR` | dónde se guardan los datos | `./data` |

## Publicarlo

GitHub Pages solo sirve archivos estáticos, así que no puede guardar reservas. Hace falta un servicio que ejecute Node y conserve la carpeta `data/` (un disco persistente). Cuando lo decidas, se despliega tal cual con `npm start`.
