import os
import sys

# Add project root to sys.path to import google_auth
_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
sys.path.insert(0, os.path.join(_ROOT, '_knowledge', 'credentials', 'oauth'))

from google_auth import get_drive_service

from googleapiclient.http import MediaFileUpload

# Path to QR image generated earlier
qr_path = os.path.abspath(os.path.join(_ROOT, 'Projeler', 'whatsapp-openai-chatbot', 'qr_actual.png'))
if not os.path.exists(qr_path):
    print('QR file not found at', qr_path)
    sys.exit(1)

drive_service = get_drive_service('account1')  # Use configured account1 token

file_metadata = {'name': 'whatsapp_qr.png'}
media = MediaFileUpload(qr_path, mimetype='image/png')
file = drive_service.files().create(body=file_metadata, media_body=media, fields='id').execute()
file_id = file.get('id')

# Make file publicly readable
drive_service.permissions().create(
    fileId=file_id,
    body={'type': 'anyone', 'role': 'reader'},
    fields='id',
).execute()

share_link = f'https://drive.google.com/file/d/{file_id}/view?usp=sharing'
print('SHARE_LINK:', share_link)
