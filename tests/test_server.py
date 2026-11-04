"""The server's input handling: which repository addresses it accepts, and reading keys from .env."""
import os

import pytest

import server


@pytest.mark.parametrize("text, expected", [
    ("https://github.com/facebook/react", ("facebook", "react", None)),
    ("github.com/facebook/react", ("facebook", "react", None)),
    ("facebook/react", ("facebook", "react", None)),
    ("https://github.com/meta-llama/llama/tree/main", ("meta-llama", "llama", "main")),
    ("https://www.github.com/BurntSushi/ripgrep/", ("BurntSushi", "ripgrep", None)),
])
def test_repository_addresses(text, expected):
    assert server.parse_github_url(text) == expected


@pytest.mark.parametrize("text", ["", "react", "https://gitlab.com/a/b", "../../etc/passwd", "a b/c"])
def test_anything_else_is_turned_down(text):
    with pytest.raises(ValueError):
        server.parse_github_url(text)


def test_env_file_fills_in_but_never_overrides(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    env.write_text("# a comment\nDJREPO_TEST_A=from-file\nDJREPO_TEST_B='quoted'\nnot a line\n", "utf-8")
    monkeypatch.setenv("DJREPO_TEST_A", "already-set")
    monkeypatch.delenv("DJREPO_TEST_B", raising=False)
    server.load_env(env)
    assert os.environ["DJREPO_TEST_A"] == "already-set"
    assert os.environ["DJREPO_TEST_B"] == "quoted"
