SELECT
  u.id,
  u.name,
  COUNT(p.id) as "postCount"
FROM
  "User" u
  LEFT JOIN "Post" p ON u.id = p."authorId"
GROUP BY
  u.id,
  u.name;