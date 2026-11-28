#!/usr/bin/env python3
"""Reconcile enrolled branch tips and same-repository PR heads over outbound HTTPS."""

import argparse
import hashlib
import hmac
import importlib.util
import json
import sys
from pathlib import Path
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen


def github_json(url, token):
    headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
    if token:
        headers["Authorization"] = "Bearer " + token.decode("ascii")
    with urlopen(Request(url, headers=headers), timeout=20) as response:
        return json.load(response)


def reconcile(controller, config, state, api):
    repo = config["repository"]
    endpoint = f"{api.rstrip('/')}/repos/{repo}"
    secret = controller.private_file(Path(config["webhookSecretFile"]))
    token_file = Path(config["githubTokenFile"])
    token = controller.private_file(token_file) if token_file.exists() else None

    def submit(event, ref, sha, payload):
        identity = json.dumps([repo, event, ref, sha], separators=(",", ":")).encode()
        body = json.dumps({"repository": {"full_name": repo}, **payload}).encode()
        headers = {"X-GitHub-Event": event, "X-GitHub-Delivery": "sync-" + hashlib.sha256(identity).hexdigest(),
                   "X-Hub-Signature-256": "sha256=" + hmac.new(secret, body, hashlib.sha256).hexdigest()}
        status, message = controller.receive(config, state, body, headers, api)
        if status != 202:
            raise ValueError(f"controller refused observed revision: {message}")

    for ref in config["refs"]:
        branch = ref.removeprefix("refs/heads/")
        tip = github_json(f"{endpoint}/branches/{quote(branch, safe='')}", token)
        if tip.get("name") != branch:
            raise ValueError("branch returned by GitHub differs from enrollment")
        sha = tip["commit"]["sha"]
        submit("push", ref, sha, {"ref": ref, "after": sha})

    page = 1
    while True:
        query = urlencode({"state": "open", "sort": "created", "direction": "asc", "per_page": 100, "page": page})
        pulls = github_json(f"{endpoint}/pulls?{query}", token)
        if not isinstance(pulls, list):
            raise ValueError("unexpected pull request list")
        for pull in pulls:
            head, base = pull["head"], pull["base"]
            ref = "refs/heads/" + base["ref"]
            source = head.get("repo") or {}
            if (ref not in config["refs"] or (base.get("repo") or {}).get("full_name") != repo
                    or source.get("full_name") != repo or source.get("fork") is True):
                continue
            accepted = {key: {"ref": side["ref"], "repo": {"full_name": repo}}
                        for key, side in (("base", base), ("head", head))}
            accepted["head"]["sha"] = head["sha"]
            submit("pull_request", ref, head["sha"], {"action": "synchronize", "pull_request": accepted})
        if len(pulls) < 100:
            return
        page += 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--api", default="https://api.github.com")
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location("cloud_revision", Path(__file__).resolve().parents[1] / "cloud-revision.py")
    controller = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(controller)
    config = controller.load_config(args.config)
    state = controller.state_dir(config)
    controller.pin_enrollment(config, state)
    reconcile(controller, config, state, args.api)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"cloud-revision observer: {error}", file=sys.stderr)
        sys.exit(1)
