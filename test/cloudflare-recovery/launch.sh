set -eu
mkdir -p /opt/data/memories
cp /lab/config.yaml /opt/data/config.yaml
if [ -n "${LAB_PERSONAL_STATE:-}" ]; then /opt/hermes/.venv/bin/python /lab/personal-state.py restore; fi
chown -R hermes:hermes /opt/data
ln -s /opt/data /store
/opt/hermes/.venv/bin/python /lab/receipt-reader.py &
/opt/hermes/.venv/bin/python /lab/personal-state.py serve &
cd /opt/data/memories
if [ -f /lab/slow-model.py ]; then
  export OPENAI_BASE_URL=http://127.0.0.1:8645/v1
  /opt/hermes/.venv/bin/python /lab/slow-model.py &
fi
exec /opt/hermes/docker/entrypoint-dispatch.sh gateway run
