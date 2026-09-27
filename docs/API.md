# API Contract (base URL: http://localhost:5000)

| Method | Endpoint                         | Purpose                          |
|--------|----------------------------------|----------------------------------|
| GET    | /api/hospitals                   | All hospitals + live resources   |
| POST   | /api/requests                    | Dispatcher creates emergency     |
| GET    | /api/requests/:id/rankings       | Ranked hospital list             |
| POST   | /api/reservations                | Reserve a hospital               |
| PATCH  | /api/reservations/:id            | Hospital accepts / rejects       |
| PATCH  | /api/reservations/:id/status     | en_route → arrived → handed_over |

Socket events: `hospital:update`, `reservation:update`
