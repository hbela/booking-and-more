# Build context: demo/wellness. Deploy independently from the app.
FROM nginx:1.31-alpine
COPY index.html patient.html staff.html styles.css patient-qr.js /usr/share/nginx/html/
COPY en /usr/share/nginx/html/en
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
