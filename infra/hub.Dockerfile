FROM node@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
RUN apk add --no-cache poppler-utils poppler-data python3
COPY extract-docx.py /app/infra/extract-docx.py
