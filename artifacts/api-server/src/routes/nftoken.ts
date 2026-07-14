import { Router } from "express";
import { getNfTokenEntry } from "../lib/nftokenStore";

const router = Router();

// GET /nftoken/:token  — redirect to the Netflix nftoken login URL
router.get("/:token", (req, res) => {
  const entry = getNfTokenEntry(req.params["token"] ?? "");
  if (!entry) {
    res.status(404).send("Link expired or not found. Netflix token URLs are valid for 1 hour.");
    return;
  }
  res.redirect(entry.nftokenUrl);
});

export default router;
