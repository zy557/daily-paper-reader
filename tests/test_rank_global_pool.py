import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch


def _load_module(module_name: str, path: pathlib.Path):
    spec = importlib.util.spec_from_file_location(module_name, path)
    mod = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(mod)
    return mod


class RankGlobalPoolTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = pathlib.Path(__file__).resolve().parents[1]
        src_dir = root / "src"
        if str(src_dir) not in sys.path:
            sys.path.insert(0, str(src_dir))
        cls.mod = _load_module("rank_mod", src_dir / "3.rank_papers.py")

    def test_resolve_global_pool_budget_scales_with_total_papers(self):
        self.assertEqual(
            self.mod.resolve_global_pool_budget(1000, 4),
            (30, 8, 120),
        )
        self.assertEqual(
            self.mod.resolve_global_pool_budget(3000, 4),
            (50, 12, 200),
        )
        self.assertEqual(
            self.mod.resolve_global_pool_budget(10000, 4),
            (120, 20, 300),
        )

    def test_build_global_candidate_ids_keeps_lane_top_and_global_top(self):
        queries = [
            {
                "type": "intent_query",
                "paper_tag": "query:AHD",
                "query_text": "how to automate",
                "sim_scores": {
                    "p1": {"rank": 1, "score": 0.9},
                    "p3": {"rank": 2, "score": 0.7},
                },
            },
            {
                "type": "keyword",
                "paper_tag": "keyword:AHD",
                "query_text": "Automated Algorithm Design",
                "sim_scores": {
                    "p2": {"rank": 1, "score": 1.0},
                    "p4": {"rank": 2, "score": 0.6},
                },
            },
        ]

        ids = self.mod.build_global_candidate_ids(
            queries,
            guaranteed_per_lane=1,
            global_limit=3,
        )

        self.assertEqual(ids, ["p1", "p2", "p3"])

    def test_process_file_reranks_intent_query_on_global_pool(self):
        payload = {
            "generated_at": "2026-03-11T00:00:00+00:00",
            "papers": [
                {"id": "p1", "title": "Intent paper", "abstract": "intent abstract"},
                {"id": "p2", "title": "Keyword only paper", "abstract": "keyword abstract"},
                {"id": "p3", "title": "Intent tail paper", "abstract": "tail abstract"},
            ],
            "queries": [
                {
                    "type": "keyword",
                    "tag": "AHD",
                    "paper_tag": "keyword:AHD",
                    "query_text": "Automated Algorithm Design",
                    "sim_scores": {
                        "p2": {"rank": 1, "score": 1.0},
                    },
                },
                {
                    "type": "intent_query",
                    "tag": "AHD",
                    "paper_tag": "query:AHD",
                    "query_text": "how to automate the discovery of new optimization algorithms",
                    "sim_scores": {
                        "p1": {"rank": 1, "score": 0.9},
                        "p3": {"rank": 2, "score": 0.8},
                    },
                },
            ],
        }

        class FakeReranker:
            def rerank(self, **kwargs):
                documents = kwargs.get("documents") or []
                self.last_documents = documents
                return {
                    "results": [
                        {"index": 1, "relevance_score": 0.95},
                        {"index": 0, "relevance_score": 0.80},
                    ]
                }

        reranker = FakeReranker()

        with tempfile.TemporaryDirectory() as tmp:
            input_path = pathlib.Path(tmp) / "input.json"
            output_path = pathlib.Path(tmp) / "output.json"
            input_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

            with patch.object(self.mod.random, "shuffle", side_effect=lambda items: None):
                self.mod.process_file(
                    reranker=reranker,
                    input_path=str(input_path),
                    output_path=str(output_path),
                    top_n=None,
                    rerank_model="fake-model",
                )

            saved = json.loads(output_path.read_text(encoding="utf-8"))
            queries = saved.get("queries") or []
            intent_queries = [q for q in queries if q.get("type") == "intent_query"]
            self.assertEqual(len(intent_queries), 1)
            ranked = intent_queries[0].get("ranked") or []
            ranked_ids = [item.get("paper_id") for item in ranked]
            self.assertEqual(ranked_ids, ["p1", "p2"])
            self.assertEqual(saved.get("global_candidate_ids"), ["p2", "p1", "p3"])
            self.assertEqual(saved.get("global_pool_lane_top_k"), 30)
            self.assertEqual(saved.get("global_pool_limit"), 60)
            self.assertEqual(saved.get("global_pool_guaranteed_per_lane"), 8)


    def test_process_file_graceful_when_rerank_raises(self):
        """process_file must not crash when rerank raises (e.g. 401 Unauthorized)."""
        payload = {
            "generated_at": "2026-03-11T00:00:00+00:00",
            "papers": [
                {"id": "p1", "title": "Paper one", "abstract": "abstract one"},
                {"id": "p2", "title": "Paper two", "abstract": "abstract two"},
            ],
            "queries": [
                {
                    "type": "intent_query",
                    "tag": "TestTag",
                    "query_text": "test query",
                    "sim_scores": {
                        "p1": {"rank": 1, "score": 0.9},
                        "p2": {"rank": 2, "score": 0.7},
                    },
                },
            ],
        }

        class FailingReranker:
            def rerank(self, **kwargs):
                raise RuntimeError("401 Client Error: Unauthorized")

        reranker = FailingReranker()

        with tempfile.TemporaryDirectory() as tmp:
            input_path = pathlib.Path(tmp) / "input.json"
            output_path = pathlib.Path(tmp) / "output.json"
            input_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

            # Must not raise – rerank failure should be handled gracefully
            self.mod.process_file(
                reranker=reranker,
                input_path=str(input_path),
                output_path=str(output_path),
                top_n=None,
                rerank_model="fake-model",
            )

            # Output file must still be written
            self.assertTrue(output_path.exists())
            saved = json.loads(output_path.read_text(encoding="utf-8"))
            # reranked_at must be present
            self.assertIn("reranked_at", saved)
            # queries must not have gained a 'ranked' key
            queries = saved.get("queries") or []
            intent_queries = [q for q in queries if q.get("type") == "intent_query"]
            self.assertEqual(len(intent_queries), 1)
            self.assertNotIn("ranked", intent_queries[0])


if __name__ == "__main__":
    unittest.main()
