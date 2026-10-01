import base64
import io
import json
import os
import re
import tempfile

import pandas as pd
import streamlit as st
import yagmail
from streamlit_local_storage import LocalStorage

st.set_page_config(page_title="Bulk Email Sender", page_icon="📧")
MAX_DEFAULT_RESUME_BYTES = 1_500_000

storage = LocalStorage(key="bulk_email_sender_storage")
try:
    saved_defaults = json.loads(storage.getItem("bulk_email_defaults") or "{}")
except (TypeError, json.JSONDecodeError):
    saved_defaults = {}

st.title("📧 Bulk Email Sender")
st.warning("Submitted defaults, including your app password, are stored in this browser's local storage and are not encrypted. Do not use this on a shared device.")
if saved_defaults.get("resume_base64") and saved_defaults.get("resume_name"):
    st.caption(f"Saved default resume: {saved_defaults['resume_name']}. It will be reused unless you upload another PDF.")

sender = st.text_input("Your Gmail", value=saved_defaults.get("sender", ""))
password = st.text_input("App Password", value=saved_defaults.get("password", ""), type="password")
subject = st.text_input("Email Subject", value=saved_defaults.get("subject", ""))
message = st.text_area("Custom Message", value=saved_defaults.get("message", ""))
recipient_text = st.text_area(
    "Email addresses (one per line)",
    value=saved_defaults.get("recipients", ""),
    help="You can enter addresses here or upload a .txt/.csv list below.",
)

email_file = st.file_uploader("Upload Email List (.txt or .csv)", type=["txt", "csv"])
resume_file = st.file_uploader("Upload Resume (PDF)", type=["pdf"])

if st.button("Send Emails"):
    recipients = []
    uploaded_resume_bytes = None
    uploaded_resume_name = ""

    try:
        if email_file:
            email_content = email_file.getvalue().decode("utf-8-sig")
            if email_file.name.lower().endswith(".csv"):
                dataframe = pd.read_csv(io.StringIO(email_content), header=None, dtype=str)
                recipient_values = dataframe.fillna("").to_numpy().flatten().tolist()
            else:
                recipient_values = email_content.splitlines()
        else:
            recipient_values = recipient_text.splitlines()

        email_pattern = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
        for value in recipient_values:
            recipients.extend(email_pattern.findall(str(value)))
        recipients = list(dict.fromkeys(email.strip() for email in recipients))

        if resume_file:
            uploaded_resume_bytes = resume_file.getvalue()
            uploaded_resume_name = os.path.basename(resume_file.name)

        if not sender or not password:
            st.error("Please enter Gmail and App Password")
            st.stop()

        if not recipients:
            st.error("No recipients found. Enter addresses or upload an email list.")
            st.stop()

        if not uploaded_resume_bytes and not saved_defaults.get("resume_base64"):
            st.error("Please upload a resume PDF before sending.")
            st.stop()

        previous_resume = saved_defaults.get("resume_base64", "")
        previous_resume_name = saved_defaults.get("resume_name", "")
        resume_base64 = previous_resume
        resume_name = previous_resume_name
        resume_was_saved = True
        if uploaded_resume_bytes:
            if len(uploaded_resume_bytes) <= MAX_DEFAULT_RESUME_BYTES:
                resume_base64 = base64.b64encode(uploaded_resume_bytes).decode("ascii")
                resume_name = uploaded_resume_name
            else:
                resume_was_saved = False

        updated_defaults = {
            "sender": sender,
            "password": password,
            "recipients": "\n".join(recipients),
            "subject": subject,
            "message": message,
            "resume_base64": resume_base64,
            "resume_name": resume_name,
        }
        storage.setItem("bulk_email_defaults", json.dumps(updated_defaults), key="save_bulk_email_defaults")

        if not resume_was_saved:
            st.warning("This PDF is larger than 1.5 MB, so it will be used for this send but not saved as a browser default.")

        st.write(f"Total recipients: {len(recipients)}")
        st.write("Recipients:", recipients)

        resume_bytes = uploaded_resume_bytes or base64.b64decode(resume_base64)
        suffix = os.path.splitext(uploaded_resume_name or resume_name)[1] or ".pdf"
        with tempfile.NamedTemporaryFile(prefix="bulk-mail-resume-", suffix=suffix, delete=False) as temporary_file:
            temporary_file.write(resume_bytes)
            resume_path = temporary_file.name

        mailer = yagmail.SMTP(user=sender, password=password)
        progress = st.progress(0)

        for index, recipient in enumerate(recipients):
            mailer.send(
                to=recipient,
                subject=subject,
                contents=message,
                attachments=resume_path,
            )
            progress.progress((index + 1) / len(recipients))
            st.write(f"Sent to: {recipient}")

        st.success("All emails sent successfully!")

    except Exception as error:
        st.error(f"Error: {str(error)}")
