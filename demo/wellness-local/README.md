# Local Wellness demo

Local counterpart of `../wellness`, with the same Hungarian and English patient/staff pages, styling, and chat-availability behavior. Application and QR links use `http://localhost:3000`; the tenant slug remains `wellness`. The staging demo is unchanged.

Start the local API and web application using the repository's normal development setup. The local database must contain the `wellness` organization; its subscription and assistant settings control whether chat is available. This website does not create or modify tenants.

To serve the demo independently, run from the repository root:

```powershell
docker build -t appointer-wellness-local demo/wellness-local
docker run --rm --name appointer-wellness-local -p 127.0.0.1:8093:80 appointer-wellness-local
```

Open <http://localhost:8093/> for Hungarian or <http://localhost:8093/en/> for English. Patient and staff links open the local app on port 3000. QR codes also point to localhost, so scanning them from another device requires a separately configured reachable development origin.

When updating the staging demo, mirror its HTML, CSS, JavaScript, and Dockerfile changes here, retaining the local application origin and environment labels. No secrets or separate environment file are needed in this folder.
