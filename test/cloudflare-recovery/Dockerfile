FROM --platform=linux/arm64 nousresearch/hermes-agent@sha256:3e9fe4c6ef36490f43aa0d0d80f9df64e9c92a576eee3042f1a97c8813c05355
COPY hub/infra/hermes.yaml /lab/config.yaml
COPY hub/infra/receipt-reader.py /lab/receipt-reader.py
COPY hub/infra/work_tools.py /opt/ai-hub/work_tools.py
COPY hub/skills/ /opt/ai-hub/skills/
COPY launch.sh /lab/launch.sh
COPY personal-state.py /lab/personal-state.py
ENTRYPOINT ["/bin/sh","/lab/launch.sh"]
