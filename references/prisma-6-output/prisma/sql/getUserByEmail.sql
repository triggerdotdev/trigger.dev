SELECT u.id, u.name
FROM "User" u
WHERE u.email = $1