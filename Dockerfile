# DJRepo in a box: the server, git and graphify. Run it with `docker compose up --build`,
# then open http://localhost:8777. Keys for the gig finder come from .env at run time and are
# never baked into the image.
FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
RUN useradd --create-home dj && mkdir -p /app/.cache && chown dj /app/.cache
USER dj

ENV PYTHONUNBUFFERED=1
EXPOSE 8777
VOLUME /app/.cache
CMD ["python", "server.py", "--host", "0.0.0.0", "--no-browser"]
