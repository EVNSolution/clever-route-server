# Driver SellerOrder assignment API

The mobile UI is out of scope. These endpoints define the shared server contract used by a future driver app.

## Operational unit

- One uploaded workbook row is one indivisible `SellerOrder` assignment unit.
- Acquisition and release move the complete order row. They do not split products, boxes, stops, or proof records.
- Release removes the assignment only. It never deletes the order.
- The active owner is the current child `RoutePlan` containing the order.

## Endpoints

### GET `/driver/orders/unassigned`

Returns only unassigned orders in the route group associated with the bearer route token.

### POST `/driver/orders/{orderId}/acquire`

Moves an unassigned order to the bearer driver's current route. The target route must already have a vehicle. The server does not guess a vehicle identifier.

The move uses the existing route-group transaction. Route membership and ETA invalidation commit atomically; successful assignment then schedules both affected routes for asynchronous stop-order, geometry, and planned-ETA recalculation. Recalculation failure is observable but does not roll back the accepted assignment. If two drivers acquire the same order, the first valid save succeeds and the loser receives:

```json
{
  "data": null,
  "error": {
    "code": "SELLER_ORDER_ALREADY_ACQUIRED",
    "message": "This order has already been acquired by another driver."
  }
}
```

If asynchronous route recalculation is unavailable, the accepted assignment remains persisted and the server records a structured scheduling failure for operational recovery.

### POST `/driver/orders/{orderId}/release`

Moves the order from the bearer driver's route into the current unassigned route. If no unassigned route exists, the server creates one as part of the same draft save.

## Transfer boundary

Transfers are accepted only while the affected route is `READY`. This avoids a clock-only race at the configured departure time and closes transfers as soon as route execution starts.

## Deferred external decisions

- WMS vehicle identifiers and payload shape
- Condition value normalization such as `Cold` versus `COLD`
- Product-detail fields not present in the supplied workbook

These are intentionally not inferred by this API.
