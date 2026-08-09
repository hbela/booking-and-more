# Hardening a Hetzner VPS with SSH Keys and a Cloud Firewall

## What I learned while securing a Coolify server

I recently revisited the security of a Hetzner Cloud VPS running Coolify and several Dockerized applications. What looked like a simple task — replace root password login with SSH keys and close unnecessary ports — turned into a useful practical lesson in SSH, OpenSSH configuration, Docker networking, Hetzner Cloud Firewall rules, and recovery procedures.

This article documents what I did, what went wrong, how I diagnosed it, and what I would do differently next time.

The final result was:

- root SSH access using an ED25519 key;
- the private key protected by a passphrase;
- Windows `ssh-agent` configured for convenient logins;
- a simple SSH alias: `ssh hetzner`;
- a Hetzner Cloud Firewall exposing only ports `22`, `80`, and `443`;
- PostgreSQL port `5432` and the Coolify direct dashboard port `8000` removed from public Internet exposure;
- the Hetzner web console retained as an emergency recovery path.

---

# 1. Starting point

The server was a Hetzner Cloud VPS running Ubuntu and Coolify.

The VPS hosted applications and supporting services in Docker. Backups were already running, and while working on a more resilient PostgreSQL backup setup I decided to improve SSH access and review the publicly exposed ports.

An external scan from my laptop showed:

```text
22    OPEN
80    OPEN
443   OPEN
5432  OPEN
6379  closed/filtered
8000  OPEN
```

This immediately highlighted two problems:

- PostgreSQL on `5432` was reachable from the public Internet.
- Coolify's direct HTTP dashboard port `8000` was also publicly reachable.

The desired end state was simple:

```text
Internet
   |
   +-- 22/tcp   SSH
   +-- 80/tcp   HTTP / redirect / ACME
   +-- 443/tcp  HTTPS
   |
   +-- everything else blocked
```

---

# 2. Why SSH keys are preferable to a root password

My first goal was to stop relying on the root account password for SSH.

A public-key login consists of two parts:

```text
Laptop
  ~/.ssh/id_ed25519
       private key
       protected by passphrase

Server
  /root/.ssh/authorized_keys
       public key
```

The private key never needs to leave the laptop.

During authentication, the server verifies that the client owns the private key corresponding to one of the public keys in:

```bash
/root/.ssh/authorized_keys
```

This is considerably stronger than exposing root password authentication to the Internet.

The intended OpenSSH configuration is essentially:

```text
PubkeyAuthentication yes
PermitRootLogin prohibit-password
```

On my server OpenSSH reported:

```text
permitrootlogin without-password
pubkeyauthentication yes
```

`without-password` is the older equivalent of `prohibit-password`.

It means:

> root SSH login is allowed with a public key, but not with the root account password.

That was exactly the configuration I wanted.

---

# 3. Adding an SSH key in Hetzner does not update an existing VPS

This was one of the first important lessons.

Hetzner Cloud has:

```text
Project
  -> Security
  -> SSH Keys
```

I added a new SSH key there.

However, adding a key to the Hetzner project does **not** automatically place it into an already-existing VPS.

Those project keys are mainly used when creating new servers.

For an existing server, the public key still has to exist in:

```bash
/root/.ssh/authorized_keys
```

This distinction is easy to miss.

---

# 4. The Hetzner web console was our recovery mechanism

Because normal SSH login was failing, I used the Hetzner server console.

The navigation is approximately:

```text
Hetzner Cloud Console
  -> Project
  -> Servers
  -> select VPS
  -> Console
```

This gives direct console access even when SSH is misconfigured.

That console became extremely important because it allowed me to work as `root` without relying on SSH.

I would always keep this recovery option in mind before changing SSH settings remotely.

A good operating rule is:

> Never close your last working administrative session while changing SSH authentication.

---

# 5. The surprising keyboard problem

The Hetzner web console introduced an unexpected complication: some keyboard characters did not behave as expected.

For example, I wanted to run:

```bash
sshd -T | grep permitrootlogin
```

but the pipe character was entered incorrectly.

Likewise:

```bash
chown -R root:root /root/.ssh
```

was accidentally interpreted as:

```bash
chown -R root;root /root/.ssh
```

because `:` became `;`.

That produced errors such as:

```text
chown: missing operand after 'root'
Command 'root' not found
```

The workaround was to avoid punctuation-heavy commands where possible:

```bash
chown -R root /root/.ssh
chgrp -R root /root/.ssh
```

This console keyboard issue later became one of the main reasons the SSH troubleshooting lasted much longer than it should have.

---

# 6. Correct SSH filesystem permissions

OpenSSH is deliberately strict about permissions.

For root key authentication I ended up with:

```text
/root                         root:root
/root/.ssh                    root:root  700
/root/.ssh/authorized_keys    root:root  600
```

Useful commands:

```bash
chmod 700 /root/.ssh
chmod 600 /root/.ssh/authorized_keys

chown -R root /root/.ssh
chgrp -R root /root/.ssh
```

Verification:

```bash
ls -ld /root
ls -ld /root/.ssh
ls -l /root/.ssh/authorized_keys
```

A typical healthy result is:

```text
drwx------ root root /root/.ssh
-rw------- root root /root/.ssh/authorized_keys
```

---

# 7. `authorized_keys` versus `authorized-keys`

This was the most painful part of the whole exercise.

OpenSSH was configured to read:

```text
.ssh/authorized_keys
.ssh/authorized_keys2
```

Notice the underscore:

```text
authorized_keys
          ^
```

During troubleshooting, another file existed:

```text
authorized-keys
          ^
```

with a hyphen.

OpenSSH ignores that file.

Both filenames looked almost identical in the tiny web console, and several checks accidentally operated on the wrong one.

This led to the misleading situation where:

- the public key fingerprint appeared correct;
- permissions appeared correct;
- the client was offering the expected key;
- but sshd still rejected the key.

The important command was:

```bash
grep -Rni AuthorizedKeysFile /etc/ssh
```

which showed the file OpenSSH actually reads.

Lesson:

> When debugging SSH keys, verify not only the key and permissions, but the exact authorized-key file path used by the running sshd.

---

# 8. Fingerprints are an excellent diagnostic tool

On Windows I checked my public key:

```powershell
ssh-keygen -lf "$env:USERPROFILE\.ssh\id_ed25519.pub"
```

On the VPS:

```bash
ssh-keygen -lf /root/.ssh/authorized_keys
```

The public-key fingerprint must be identical on both machines.

The exact fingerprint is intentionally omitted from this public article, but the pattern looks like:

```text
256 SHA256:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx user@example.com (ED25519)
```

This allowed me to prove that the correct public key had finally reached the correct server-side file.

---

# 9. Using `ssh -vvv` from Windows

When a normal SSH attempt still failed, the next useful tool was:

```powershell
ssh -vvv -i "$env:USERPROFILE\.ssh\id_ed25519" root@SERVER_IP
```

The important lines were:

```text
Offering public key: ...
```

followed by:

```text
Authentications that can continue: publickey,password
```

That told me:

- the network connection was fine;
- the Windows SSH client could read the private key;
- the correct key was being offered;
- the server was rejecting it.

At that point, continuing to regenerate keys would have been pointless.

The problem was server-side.

---

# 10. The SSH server logs

On Ubuntu, one useful command is:

```bash
journalctl -u ssh -n 30 --no-pager
```

This showed successful internal SSH connections such as:

```text
Accepted publickey for root from 10.x.x.x ...
```

That proved that public-key authentication for root was working in general.

It also showed that a different key was already used internally, most likely by Coolify or another automation process.

That was another important warning:

> Never overwrite `authorized_keys` blindly on a managed server.

There may already be automation keys that must be preserved.

---

# 11. Running a temporary debug SSH server

The most useful diagnostic technique was starting a second sshd instance on another port.

For example:

```bash
/usr/sbin/sshd -ddd -p 2222 -E /tmp/sshd-debug.log
```

This leaves the normal SSH service on port `22` untouched.

Then from the laptop:

```powershell
ssh -p 2222 -o PasswordAuthentication=no -o IdentitiesOnly=yes -i "$env:USERPROFILE\.ssh\id_ed25519" root@SERVER_IP
```

The debug log could then be inspected:

```bash
grep -i authorized /tmp/sshd-debug.log
grep -i publickey /tmp/sshd-debug.log
grep -i allowed /tmp/sshd-debug.log
```

This showed exactly which file sshd was reading and whether the offered key matched.

This is a technique I would use much earlier next time.

---

# 12. Temporary password-only SSH on port 2222

Eventually the Hetzner web console itself became the biggest obstacle because of its keyboard mapping.

The cleanest escape was to start a temporary SSH daemon that explicitly allowed root password login on port `2222`:

```bash
/usr/sbin/sshd -D -p 2222 \
  -o PermitRootLogin=yes \
  -o PasswordAuthentication=yes \
  -o PubkeyAuthentication=no \
  -E /tmp/sshd-temp.log
```

This did **not** change the production SSH service on port `22`.

From PowerShell:

```powershell
ssh -p 2222 `
  -o PubkeyAuthentication=no `
  -o PreferredAuthentications=password `
  root@SERVER_IP
```

This finally gave me a normal terminal:

```text
root@my-ubuntu-server:~#
```

Now all normal characters, pipes, redirection, underscores, and copy/paste worked correctly.

This was the turning point.

---

# 13. Transfer the public key instead of typing it

Once I had a normal SSH shell on port `2222`, I stopped manually entering the public key.

From Windows:

```powershell
scp -P 2222 "$env:USERPROFILE\.ssh\id_ed25519.pub" root@SERVER_IP:/root/windows_id_ed25519.pub
```

Then on the server:

```bash
ssh-keygen -lf /root/windows_id_ed25519.pub
```

I backed up the existing authorized-key file:

```bash
cp -a /root/.ssh/authorized_keys /root/.ssh/authorized_keys.before-fix
```

Then appended the transferred key:

```bash
cat /root/windows_id_ed25519.pub >> /root/.ssh/authorized_keys
```

and restored correct permissions:

```bash
chown root:root /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
chmod 700 /root/.ssh
```

This eliminated all uncertainty caused by manually copying a long key through the VNC console.

---

# 14. Verify the effective OpenSSH configuration

Now that a normal terminal was available, this command worked properly:

```bash
sshd -T | grep -E 'permitrootlogin|pubkeyauthentication|authorizedkeysfile|authenticationmethods|strictmodes|pubkeyacceptedalgorithms'
```

My effective configuration included:

```text
permitrootlogin without-password
pubkeyauthentication yes
strictmodes yes
authorizedkeysfile .ssh/authorized_keys .ssh/authorized_keys2
authenticationmethods any
```

and `ssh-ed25519` appeared in the accepted public-key algorithms.

Everything required for ED25519 root-key authentication was therefore enabled.

---

# 15. Success: normal port 22 key login

The decisive test from Windows was:

```powershell
ssh -o PasswordAuthentication=no -o IdentitiesOnly=yes -i "$env:USERPROFILE\.ssh\id_ed25519" root@SERVER_IP
```

This time I was asked:

```text
Enter passphrase for key ...
```

and after entering it:

```text
Welcome to Ubuntu ...
root@my-ubuntu-server:~#
```

Success.

The important distinction is:

```text
Root password          != SSH private-key passphrase
```

The VPS was no longer asking for the root account password.

It was asking for the passphrase that protects the private key stored on my laptop.

That is the behavior I wanted.

---

# 16. Create a convenient SSH alias

Instead of typing the full SSH command every time, I created:

```text
C:\Users\<username>\.ssh\config
```

with:

```sshconfig
Host hetzner
    HostName SERVER_IP
    User root
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes
```

Now the login command is simply:

```powershell
ssh hetzner
```

---

# 17. Windows `ssh-agent`

I kept the passphrase on the private key.

Removing the passphrase would make login easier, but would also mean that anyone who obtained the private-key file could use it immediately.

A better solution is Windows `ssh-agent`.

Open an Administrator PowerShell:

```powershell
Get-Service ssh-agent
Get-Service ssh-agent | Set-Service -StartupType Automatic
Start-Service ssh-agent
```

Then in a normal PowerShell:

```powershell
ssh-add "$env:USERPROFILE\.ssh\id_ed25519"
```

Enter the private-key passphrase once.

Verify:

```powershell
ssh-add -l
```

Now:

```powershell
ssh hetzner
```

can reuse the loaded key without repeatedly asking for the passphrase.

The private key remains passphrase-protected on disk.

---

# 18. Public port audit

With SSH finally working reliably, I returned to the original security problem.

The external scan showed:

```text
22    OPEN
80    OPEN
443   OPEN
5432  OPEN
6379  closed/filtered
8000  OPEN
```

The desired public services were:

```text
22   SSH
80   HTTP
443  HTTPS
```

Everything else should be private unless there is a specific reason to expose it.

---

# 19. Why port 5432 should not be public

`5432` is PostgreSQL's normal TCP port.

Applications running on the same Coolify/Docker server normally do not require the database to be publicly reachable.

They can communicate over Docker/private networking.

A public database listener creates unnecessary attack surface:

```text
Internet
   |
   X 5432
   |
PostgreSQL
```

Even if authentication is strong, there is usually no reason for anonymous Internet hosts to be able to reach the database service.

So `5432` should be blocked at the infrastructure firewall unless remote database access is explicitly required.

If external administrative access is necessary, safer alternatives include:

- SSH tunneling;
- VPN/private networking;
- temporarily allowing a specific source IP.

---

# 20. Why Coolify port 8000 should not be public

Coolify can expose its dashboard directly through:

```text
http://SERVER_IP:8000
```

Once Coolify is accessible through a proper HTTPS hostname and reverse proxy, direct public access to `8000` is normally unnecessary.

The public dashboard should instead flow through:

```text
Internet
   |
   443
   |
Reverse proxy
   |
Coolify
```

rather than:

```text
Internet
   |
   8000
   |
Coolify dashboard
```

This also prevents users from accessing the management interface over plaintext HTTP.

Other Coolify-related ports such as `6001` and `6002` should similarly not be opened publicly unless there is a specific need.

---

# 21. Why I chose the Hetzner Cloud Firewall

It is tempting to configure only UFW on the Ubuntu host.

However, with Docker and published container ports, firewall behavior can be more complicated because Docker manages its own iptables/nftables rules.

A provider-level firewall gives an additional perimeter:

```text
Internet
   |
Hetzner Cloud Firewall
   |
VPS
   |
Docker
   |
Applications
```

Traffic rejected by the Hetzner firewall never reaches the VPS.

This makes it an excellent first line of defense.

---

# 22. My basic Hetzner firewall

In the Hetzner Cloud Console:

```text
Project
  -> Firewalls
  -> Create Firewall
```

I created inbound rules only for:

| Protocol | Port | Purpose |
| -------- | ---: | ------- |
| TCP      |   22 | SSH     |
| TCP      |   80 | HTTP    |
| TCP      |  443 | HTTPS   |

I intentionally did **not** add inbound rules for:

```text
5432
6379
6001
6002
8000
```

The firewall was then attached to the VPS.

Conceptually:

```text
                 Hetzner Cloud Firewall
                         |
        +----------------+----------------+
        |                |                |
       22               80               443
       SSH              HTTP             HTTPS
        |
        +--------------------------------------+
                                               |
                                    everything else
                                          blocked
```

---

# 23. SSH port 22: restrict later if appropriate

A further hardening step is restricting SSH to a known public IP:

```text
TCP 22
Source: YOUR_PUBLIC_IP/32
```

However, this is only convenient if the client Internet connection has a sufficiently stable public IP.

If the ISP frequently changes the address, an overly strict rule can lock you out.

For that reason I initially kept port `22` reachable and relied on:

```text
PermitRootLogin prohibit-password
PubkeyAuthentication yes
```

plus the passphrase-protected SSH key.

Later, SSH can be tightened further using:

- a stable source IP rule;
- WireGuard/Tailscale/private VPN;
- a non-root administration account plus `sudo`;
- rate limiting / fail2ban where appropriate.

---

# 24. External verification matters

A firewall is not finished until it is tested from outside.

From my laptop I can scan the relevant ports:

```powershell
nmap -Pn -p 22,80,443,5432,6379,6001,6002,8000 SERVER_IP
```

The desired result is approximately:

```text
22/tcp    open
80/tcp    open
443/tcp   open

5432/tcp  filtered
6379/tcp  filtered
6001/tcp  filtered
6002/tcp  filtered
8000/tcp  filtered
```

`filtered` is a good result here. It generally means that the firewall is silently dropping the connection attempt.

After changing firewall rules, I also verify the actual services:

```text
ssh hetzner                 works
https://coolify.example     works
deployed applications       work
```

---

# 25. Firewalling is not the same as removing the exposure

Blocking `5432` and `8000` at Hetzner solves the immediate Internet exposure.

But defense in depth means I should also inspect why those ports were listening publicly on the host.

Useful commands:

```bash
ss -lntp
```

and:

```bash
docker ps --format "table {{.Names}}\t{{.Ports}}"
```

For example, a PostgreSQL container might show:

```text
0.0.0.0:5432->5432/tcp
```

That means Docker has published the database port on every host interface.

The better long-term solution is usually:

```text
PostgreSQL
   |
Docker private network
   |
Application
```

with **no public host-port mapping at all**.

The Hetzner firewall then remains a second layer of protection rather than the only layer.

---

# 26. The final security model

The resulting architecture is:

```text
                    Internet
                       |
                       v
              Hetzner Cloud Firewall
                       |
             +---------+---------+
             |         |         |
            22        80        443
             |         |         |
             v         v         v
           SSH       HTTP      HTTPS
             |                   |
             |                Coolify
             |                / apps
             |
   public-key authentication
             |
             v
    /root/.ssh/authorized_keys

PostgreSQL / Redis / internal services
             |
             v
        Docker networks
             |
      not Internet-facing
```

This is much cleaner than exposing individual infrastructure services directly.

---

# 27. What I would do differently next time

The biggest lesson is procedural.

I would use this order:

1. Keep the Hetzner web console available for emergency recovery.
2. Inspect the existing `/root/.ssh/authorized_keys`.
3. Back it up immediately.
4. Transfer the new `.pub` file with `scp` instead of manually pasting it.
5. Compare fingerprints.
6. Check effective configuration with `sshd -T`.
7. Test with `ssh -vvv`.
8. If still unclear, start a temporary `sshd -ddd` on another port.
9. Never overwrite existing automation/Coolify keys.
10. Once SSH works, configure `ssh-agent`.
11. Create a provider-level firewall.
12. Externally scan the VPS.
13. Finally remove unnecessary Docker host-port mappings.

The temporary port-2222 SSH server was particularly valuable. It allowed recovery without modifying the production port-22 daemon.

---

# 28. Commands worth keeping in my notes

## SSH client

```powershell
ssh hetzner
```

Verbose diagnosis:

```powershell
ssh -vvv hetzner
```

Fingerprint:

```powershell
ssh-keygen -lf "$env:USERPROFILE\.ssh\id_ed25519.pub"
```

Agent:

```powershell
ssh-add "$env:USERPROFILE\.ssh\id_ed25519"
ssh-add -l
```

## SSH server

Check keys:

```bash
ssh-keygen -lf /root/.ssh/authorized_keys
```

Permissions:

```bash
ls -ld /root
ls -ld /root/.ssh
ls -l /root/.ssh/authorized_keys
```

Effective configuration:

```bash
sshd -T
```

Focused configuration:

```bash
sshd -T | grep -E 'permitrootlogin|pubkeyauthentication|authorizedkeysfile|authenticationmethods|strictmodes'
```

SSH logs:

```bash
journalctl -u ssh -n 50 --no-pager
```

Validate configuration before reload:

```bash
sshd -t
```

Reload:

```bash
systemctl reload ssh
```

## Network exposure

Listening TCP sockets:

```bash
ss -lntp
```

Docker published ports:

```bash
docker ps --format "table {{.Names}}\t{{.Ports}}"
```

External scan:

```powershell
nmap -Pn -p 22,80,443,5432,6379,6001,6002,8000 SERVER_IP
```

---

# 29. Final checklist

My current checklist for a small Coolify/Hetzner production VPS is:

- [x] SSH public-key login works.
- [x] Root password login over SSH is disabled.
- [x] Private key has a passphrase.
- [x] Windows `ssh-agent` handles the key.
- [x] Convenient SSH alias configured.
- [x] Existing Coolify/automation SSH keys preserved.
- [x] Hetzner Cloud Firewall attached.
- [x] Port `22` exposed for SSH.
- [x] Port `80` exposed for HTTP/ACME.
- [x] Port `443` exposed for HTTPS.
- [x] Port `5432` blocked publicly.
- [x] Port `6379` blocked publicly.
- [x] Port `8000` blocked publicly.
- [ ] Verify ports `6001` and `6002`.
- [ ] Inspect Docker port mappings.
- [ ] Remove unnecessary public database host mappings.
- [ ] Re-run external port scan.
- [ ] Consider restricting SSH source addresses later.
- [ ] Review pending Ubuntu updates and reboot when appropriate.

---

# Conclusion

What began as a simple SSH-key setup became a useful security review of the entire VPS.

The key lessons were not just individual commands. They were about layering:

```text
SSH key security
+
OpenSSH configuration
+
filesystem permissions
+
provider firewall
+
Docker network isolation
+
external verification
```

No single layer should carry the entire responsibility.

The Hetzner console is useful as a recovery channel, but a normal SSH terminal is far better for routine administration. The Hetzner Cloud Firewall provides a strong perimeter, but unnecessary Docker port mappings should still be removed. SSH keys are stronger than passwords, but private keys should still be protected with passphrases and an agent.

Most importantly:

> When troubleshooting remote access, keep one known-good administrative path open until the replacement has been tested successfully.

That one habit can turn a potentially dangerous server lockout into a controlled configuration change.
