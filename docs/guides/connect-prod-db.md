es — pgAdmin is a much nicer way to poke around, and it's a reasonable thing to want. One firm constraint though: do it over an SSH tunnel, and do not publish port 5432.

That's not caution for its own sake. Phase-10 §2.9 records that CERT-Bund found this exact server's PostgreSQL open to the internet on 2026-08-04, from a published port created on the server rather than from either compose file. The rule that came out of it is the non-obvious part: ufw deny does not close a published container port, because Docker's DNAT runs before UFW's INPUT chain. So "I'll publish it and firewall it with ufw" produces a database that is open while looking closed.

A tunnel avoids the question entirely — nothing new listens anywhere.

Step 1, on the VPS. The compose file publishes no host port for postgres, so there's nothing on the host's localhost:5432 to forward to; the tunnel has to target the container's address on the Docker network:


PG=$(docker ps --format '{{.Names}}\t{{.Image}}' | grep 'postgres:18-alpine' | cut -f1)
docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$PG"
docker exec "$PG" printenv POSTGRES_USER POSTGRES_DB
That gives you an address like 172.18.0.3. You'll also need the password, which lives in Coolify's environment variables for the stack (or docker exec "$PG" printenv POSTGRES_PASSWORD — just be aware that puts it in your scrollback and then in pgAdmin's saved-password store).

Step 2, on your laptop. Leave this running in a terminal:


ssh -N -L 15432:172.18.0.3:5432 root@<your-server-ip>
Use 15432, not 5432. Your dev machine already runs native PostgreSQL 18 on 5432 — forwarding onto that port either fails to bind or, worse, leaves you unsure which database pgAdmin is showing you. Distinct port, no ambiguity.

Step 3 — pgAdmin. New server → Host localhost, Port 15432, Database booking_and_more, User postgres, password from step 1. It'll behave like a local connection.

Two things worth knowing:

The container IP changes when the stack is recreated, so after any redeploy you re-run the docker inspect line. If that annoys you, the durable fix is to bind-publish to loopback only, in docker-compose.coolify.yml:


    ports:
      - "127.0.0.1:5432:5432"
Then the tunnel becomes the simpler ssh -N -L 15432:localhost:5432 root@<ip>. A 127.0.0.1: prefix binds loopback only and is not internet-reachable — but note that dropping the prefix, to plain "5432:5432", is precisely the shape that got you reported. If you take this route the prefix is load-bearing, and the Hetzner Cloud Firewall stays as the backstop either way. It also needs a successful deploy, which you don't currently have.

And a discipline note, since pgAdmin can write: read whatever you like, but don't let it change schema. Rule 1 exists because a predecessor's out-of-band change plus a backfill left a comment-only migration file and a production drift incident — and prisma migrate s