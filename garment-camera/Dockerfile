FROM python:3.11-slim
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
RUN apt-get update && apt-get install -y --no-install-recommends libglib2.0-0 libgomp1 ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY capture_line.py tablet.html manifest.webmanifest icon-192.png icon-512.png icon-maskable-512.png apple-touch-icon.png favicon-32.png favicon.ico ./
CMD ["python", "-u", "capture_line.py"]
