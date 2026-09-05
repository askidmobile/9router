"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import Modal from "./Modal";
import Button from "./Button";
import { saveModelName } from "@/shared/hooks/useModelNames";

// Mounted for one model at a time by media and passthrough model cards.
export default function EditModelNameModal({ model, onClose }) {
  const [name, setName] = useState(model.name || model.id);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await saveModelName({ ...model, name });
      onClose();
    } catch (err) {
      setError(err.message || "Failed to save display name");
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal isOpen onClose={onClose} title="Edit model name" footer={
      <><Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button><Button onClick={save} loading={saving}>Save</Button></>
    }>
      <div className="flex flex-col gap-3">
        <code className="text-xs text-text-muted break-all">{model.providerAlias}/{model.id}</code>
        {error && <p className="text-sm text-red-500">{error}</p>}
        <label htmlFor="edit-model-name" className="text-sm font-medium">Display name</label>
        <input id="edit-model-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={256}
          placeholder={model.defaultName || model.id}
          className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:border-primary" />
        <p className="text-xs text-text-muted">Leave empty to restore the original name. Model ID and routing alias stay the same.</p>
      </div>
    </Modal>
  );
}

EditModelNameModal.propTypes = {
  model: PropTypes.shape({ id: PropTypes.string.isRequired, providerAlias: PropTypes.string.isRequired, name: PropTypes.string, defaultName: PropTypes.string }).isRequired,
  onClose: PropTypes.func.isRequired,
};
